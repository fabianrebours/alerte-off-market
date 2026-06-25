import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { config } from '../config.ts';
import { upsertAgentGoogle } from '../db.ts';
import { encryptToken } from '../agents/tokenCrypto.ts';

/**
 * Flux OAuth Google pour que chaque agent CONNECTE sa boîte Matera et consente
 * au scope gmail.send. On stocke son refresh token (chiffré) en local ; l'envoi
 * partira ensuite de SA boîte.
 *
 * Prérequis Google Cloud (à faire une fois — cf. README) :
 *  - Écran de consentement OAuth « Interne » (org matera.eu)
 *  - Scope autorisé : https://www.googleapis.com/auth/gmail.send
 *  - URI de redirection : {APP_BASE_URL}/oauth/google/callback
 */

export const oauthRouter = Router();

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'];
const redirectUri = `${config.appBaseUrl}/oauth/google/callback`;

/** États CSRF en mémoire (TTL court). Suffisant pour un outil interne. */
const etats = new Map<string, number>();
function nettoyerEtats() {
  const maintenant = Date.now();
  for (const [k, exp] of etats) if (exp < maintenant) etats.delete(k);
}

function client() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, redirectUri);
}

/** Échappe une valeur interpolée dans le HTML servi (anti-XSS réfléchie). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(titre: string, corps: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titre}</title></head>
<body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#FAF5EE;display:flex;min-height:100vh;align-items:center;justify-content:center;">
<div style="background:#fff;max-width:460px;padding:40px;border-radius:12px;box-shadow:0 1px 3px rgba(74,18,20,.12);text-align:center;">
${corps}
<p style="margin-top:24px;"><a href="/" style="color:#721C1F;font-size:14px;">← Retour à l'application</a></p>
</div></body></html>`;
}

// Démarre le consentement Google.
oauthRouter.get('/oauth/google/start', (_req, res) => {
  if (!config.google.clientId || !config.google.clientSecret) {
    return res.status(400).send(page('Configuration manquante',
      `<p style="color:#b91c1c;">GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET non configurés.</p>`));
  }
  nettoyerEtats();
  const state = randomUUID();
  etats.set(state, Date.now() + 10 * 60 * 1000); // 10 min
  const url = client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force la délivrance d'un refresh_token
    scope: SCOPES,
    state,
  });
  res.redirect(url);
});

// Callback : échange le code, récupère le refresh token + l'email, stocke.
oauthRouter.get('/oauth/google/callback', async (req, res) => {
  const code = String(req.query.code ?? '');
  const state = String(req.query.state ?? '');
  if (!code || !etats.has(state)) {
    return res.status(400).send(page('Lien invalide', `<p style="color:#b91c1c;">Requête OAuth invalide ou expirée.</p>`));
  }
  etats.delete(state);

  try {
    const oauth2 = client();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(400).send(page('Reconnexion nécessaire',
        `<p style="color:#b45309;">Google n'a pas renvoyé de refresh token. Révoquez l'accès dans votre compte Google puis recommencez.</p>`));
    }
    // Email du compte qui vient de consentir.
    oauth2.setCredentials({ access_token: tokens.access_token ?? undefined });
    const info = await oauth2.getTokenInfo(tokens.access_token ?? '');
    const email = info.email?.toLowerCase();
    if (!email) {
      return res.status(400).send(page('Email introuvable', `<p style="color:#b91c1c;">Impossible de lire l'email du compte Google.</p>`));
    }
    if (!email.endsWith('@matera.eu')) {
      return res.status(403).send(page('Compte non autorisé',
        `<p style="color:#b91c1c;">Seuls les comptes @matera.eu peuvent être connectés (reçu : ${esc(email)}).</p>`));
    }

    upsertAgentGoogle(email, null, encryptToken(tokens.refresh_token), new Date().toISOString());
    res.send(page('Compte connecté',
      `<div style="color:#721C1F;font-size:40px;margin-bottom:12px;">✓</div>
       <h1 style="color:#4A1214;font-size:20px;margin:0 0 12px;">Compte Google connecté</h1>
       <p style="color:#475569;font-size:15px;line-height:1.6;">
         Les mails off-market pour vos biens partiront désormais depuis <strong>${esc(email)}</strong>.
       </p>`));
  } catch (e) {
    res.status(502).send(page('Échec de connexion',
      `<p style="color:#b91c1c;">Échec de l'échange OAuth : ${esc((e as Error).message)}</p>`));
  }
});
