import { Router } from 'express';
import { emailParToken, ajouterDesinscription, estDesinscrit } from '../db.ts';

export const optoutRouter = Router();

/** Échappe le HTML d'une valeur interpolée (défense en profondeur). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(titre: string, corps: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(titre)}</title></head>
<body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#FAF5EE;display:flex;min-height:100vh;align-items:center;justify-content:center;">
<div style="background:#fff;max-width:440px;padding:40px;border-radius:12px;box-shadow:0 1px 3px rgba(74,18,20,.12);text-align:center;">
  <div style="color:#4A1214;font-weight:700;font-size:15px;letter-spacing:.5px;margin-bottom:24px;">MATERA TRANSACTION</div>
  ${corps}
</div></body></html>`;
}

const pageLienInvalide = () => page('Lien invalide',
  `<p style="color:#475569;font-size:15px;line-height:1.6;">Ce lien de désinscription n'est pas valide ou a expiré.</p>`);

/** Jeton factice des « emails de test à soi-même » (voir routes/biens.ts). */
const TOKEN_APERCU = 'apercu';

const pageApercu = () => page('Aperçu — email d\'essai',
  `<h1 style="color:#4A1214;font-size:20px;margin:0 0 12px;">Ceci est un email d'essai</h1>
   <p style="color:#475569;font-size:15px;line-height:1.6;">
     Ce lien provient d'un email de test envoyé à soi-même : il n'est rattaché à aucun
     destinataire, il n'y a donc personne à désinscrire.
   </p>
   <p style="color:#475569;font-size:15px;line-height:1.6;">
     Dans les envois de campagne, chaque destinataire reçoit un lien personnel
     qui le désinscrit en un clic.
   </p>`);

const pageConfirmee = (email: string) => page('Désinscription confirmée',
  `<div style="color:#721C1F;font-size:40px;margin-bottom:12px;">✓</div>
   <h1 style="color:#4A1214;font-size:20px;margin:0 0 12px;">Vous êtes désinscrit·e</h1>
   <p style="color:#475569;font-size:15px;line-height:1.6;">
     L'adresse <strong>${escapeHtml(email)}</strong> ne recevra plus d'informations sur les biens à proximité.
   </p>`);

/**
 * GET = page de CONFIRMATION uniquement (aucune écriture). Un GET qui désinscrit
 * est déclenché par le prefetch des clients mail/antivirus → désinscription à
 * l'insu. La désinscription effective passe par le POST ci-dessous.
 */
optoutRouter.get('/desinscription', (req, res) => {
  const token = String(req.query.token ?? '');
  if (token === TOKEN_APERCU) return res.send(pageApercu());
  const email = token ? emailParToken(token) : null;
  if (!email) return res.status(400).send(pageLienInvalide());
  if (estDesinscrit(email)) return res.send(pageConfirmee(email));

  res.send(page('Confirmer la désinscription',
    `<h1 style="color:#4A1214;font-size:20px;margin:0 0 12px;">Se désinscrire</h1>
     <p style="color:#475569;font-size:15px;line-height:1.6;">
       Confirmez que <strong>${escapeHtml(email)}</strong> ne souhaite plus recevoir d'informations sur les biens à proximité.
     </p>
     <form method="post" action="/desinscription?token=${encodeURIComponent(token)}" style="margin-top:20px;">
       <button type="submit" style="background:#721C1F;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:14px;font-weight:600;cursor:pointer;">
         Confirmer la désinscription
       </button>
     </form>`));
});

/**
 * POST = désinscription effective. Sert AUSSI le « un-clic » RFC 8058
 * (en-tête List-Unsubscribe-Post envoyé par Gmail/Yahoo) : même URL, même token.
 */
optoutRouter.post('/desinscription', (req, res) => {
  const token = String(req.query.token ?? '');
  if (token === TOKEN_APERCU) return res.send(pageApercu());
  const email = token ? emailParToken(token) : null;
  if (!email) return res.status(400).send(pageLienInvalide());
  if (!estDesinscrit(email)) ajouterDesinscription(email, new Date().toISOString());
  res.send(pageConfirmee(email));
});
