import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { config } from '../config.ts';
import { signerSession } from '../auth/session.ts';

/**
 * Login SSO Google pour ACCÉDER à l'outil (distinct de /oauth/google/* qui
 * connecte une boîte pour l'envoi). Scopes minimaux (openid+email), restreint
 * au domaine @matera.eu. Émet un jeton de session signé renvoyé au SPA en
 * fragment d'URL (#token=…), que le front stocke et envoie en Bearer.
 *
 * Prérequis Google Cloud : ajouter {APP_BASE_URL}/auth/callback aux URIs de
 * redirection autorisées du client OAuth.
 */
export const authRouter = Router();

const SCOPES = ['openid', 'email'];
const redirectUri = `${config.appBaseUrl}/auth/callback`;

const etats = new Map<string, number>();
function nettoyerEtats() {
  const maintenant = Date.now();
  for (const [k, exp] of etats) if (exp < maintenant) etats.delete(k);
}

function client() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, redirectUri);
}

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

// Démarre la connexion Google.
authRouter.get('/auth/login', (_req, res) => {
  if (!config.google.clientId || !config.google.clientSecret) {
    return res.status(400).send(page('Configuration manquante',
      `<p style="color:#b91c1c;">GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET non configurés.</p>`));
  }
  nettoyerEtats();
  const state = randomUUID();
  etats.set(state, Date.now() + 10 * 60 * 1000); // 10 min
  const url = client().generateAuthUrl({
    scope: SCOPES,
    state,
    hd: 'matera.eu', // n'affiche que les comptes du domaine
    prompt: 'select_account',
  });
  res.redirect(url);
});

// Callback : échange le code, vérifie l'email @matera.eu, émet la session.
authRouter.get('/auth/callback', async (req, res) => {
  const code = String(req.query.code ?? '');
  const state = String(req.query.state ?? '');
  if (!code || !etats.has(state)) {
    return res.status(400).send(page('Lien invalide', `<p style="color:#b91c1c;">Requête de connexion invalide ou expirée.</p>`));
  }
  etats.delete(state);

  try {
    const oauth2 = client();
    const { tokens } = await oauth2.getToken(code);
    const info = await oauth2.getTokenInfo(tokens.access_token ?? '');
    const email = info.email?.toLowerCase();
    if (!email || !email.endsWith('@matera.eu')) {
      return res.status(403).send(page('Accès refusé',
        `<h1 style="color:#4A1214;font-size:20px;margin:0 0 12px;">Accès refusé</h1>
         <p style="color:#475569;font-size:15px;line-height:1.6;">Seuls les comptes <strong>@matera.eu</strong> peuvent se connecter${email ? ` (reçu : ${esc(email)})` : ''}.</p>`));
    }
    const session = signerSession(email);
    // Jeton en fragment : jamais transmis au serveur, lu côté client puis effacé.
    res.redirect(`/#token=${encodeURIComponent(session)}`);
  } catch (e) {
    res.status(502).send(page('Échec de connexion',
      `<p style="color:#b91c1c;">Échec de la connexion Google : ${esc((e as Error).message)}</p>`));
  }
});
