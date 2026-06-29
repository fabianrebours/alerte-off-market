import { config } from '../config.ts';
import type { BienModelo } from '../modelo/types.ts';

/** Lien vers la landing page du bien (Scaleway) : {base}/modelo-{product_ref}.html */
export function lienAnnonce(bien: BienModelo): string {
  return `${config.lpBaseUrl}/modelo-${encodeURIComponent(bien.productRef)}.html`;
}

/** Échappe le HTML d'un texte libre (message de l'agent). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Formate un mobile FR ("0642731576" ou "+33642731576") → "06 42 73 15 76". */
function formatTelephone(tel: string | null): string | null {
  if (!tel) return null;
  let d = tel.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('33')) d = '0' + d.slice(2); // +33… → 0…
  return d.length === 10 ? d.replace(/(\d{2})(?=\d)/g, '$1 ').trim() : tel;
}

/** Article indéfini selon le type (maison/villa → une, sinon un). */
function article(type: string | null): string {
  return /maison|villa/i.test(type ?? '') ? 'une' : 'un';
}

/** Distance lisible : <1 km → "120 m", sinon "0,8 km". `null` → "proximité". */
export function formatDistance(km: number | null | undefined): string {
  if (km == null || !Number.isFinite(km)) return 'proximité';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1).replace('.', ',')} km`;
}

/** Substitue les variables restantes du message (seul {{distance}} est par destinataire). */
export function rendreMessage(message: string, distanceLabel: string): string {
  return message.replace(/\{\{\s*distance\s*\}\}/gi, distanceLabel);
}

/**
 * Sujet + corps par défaut, éditables par l'agent. Tout est pré-rempli depuis
 * Modelo (prénom, type, adresse, pièces, surface, téléphone) SAUF `{{distance}}`,
 * substitué à l'envoi par la distance copro→bien de chaque destinataire.
 */
export function genererBrouillonDefaut(bien: BienModelo): { sujet: string; message: string } {
  const prenom = bien.agentNom?.trim().split(/\s+/)[0] || 'votre conseiller Matera';
  const tel = formatTelephone(bien.agentTelephone);
  const typeLower = (bien.typeBien ?? 'bien').toLowerCase();
  // Confidentialité de l'adresse — liste blanche stricte : on ne divulgue la rue
  // + n° QUE pour un mandat exclusif (le bien est verrouillé chez nous, aucun
  // doute). Pour tout le reste — semi-exclusif, délégation, simple, ou type
  // inconnu/non synchronisé (null) — on masque et on ne garde que le secteur.
  // Principe : au moindre doute, on n'affiche pas l'adresse.
  const secteur = [bien.codePostal, bien.ville].filter(Boolean).join(' ');
  const lieu = bien.mandatType === 'exclusif' && bien.adresse
    ? `au ${bien.adresse}`
    : (secteur ? `dans votre quartier (${secteur})` : 'dans votre quartier');
  let carac = '';
  if (bien.pieces && bien.surface) carac = `C'est un ${bien.pieces} pièces de ${bien.surface} m². `;
  else if (bien.pieces) carac = `C'est un ${bien.pieces} pièces. `;
  else if (bien.surface) carac = `Il fait ${bien.surface} m². `;

  const sujet = `Un bien en off-market juste à côté de chez vous`;
  const message =
    `Bonjour,\n\n` +
    `Je suis ${prenom}, votre agent immobilier Matera chargé de votre secteur. ` +
    `Votre copropriété étant gérée par Matera, vous faites partie de nos clients prioritaires.\n\n` +
    `Je viens de rentrer ${article(bien.typeBien)} ${typeLower} à {{distance}} de chez vous, ${lieu}. ` +
    `${carac}Il n'est pas encore en ligne : je préfère en parler aux copropriétaires Matera du coin avant de le publier sur les sites.\n\n` +
    `Je me suis dit que ce bien pouvait vous intéresser, pour vous ou pour un proche qui cherche à s'installer dans le quartier.\n\n` +
    `Vous pouvez le découvrir ici : {{lien}}\n\n` +
    `Si vous souhaitez le visiter ou en parler, appelez-moi ou répondez à ce mail.\n\n` +
    `${prenom}${tel ? `\n${tel}` : ''}`;
  return { sujet, message };
}

interface EmailParams {
  bien: BienModelo;
  messageAgent: string;
  unsubscribeUrl: string;
  /** Token de l'envoi. Si fourni → lien tracké (clic) + pixel (ouverture). */
  token?: string;
}

/** URL de redirection trackée du clic sur le lien d'annonce. */
function lienTracke(token: string): string {
  return `${config.appBaseUrl}/c?token=${encodeURIComponent(token)}`;
}

/**
 * HTML de l'email — volontairement BRUT, comme un mail perso : pas de logo, pas
 * de carte ni de bloc centré, texte aligné à gauche pleine largeur, juste le
 * message + une photo, et un lien de désinscription discret (obligatoire RGPD).
 */
export function construireEmailHtml({ bien, messageAgent, unsubscribeUrl, token }: EmailParams): string {
  const photo = bien.photos[0] ?? null;
  const titre = bien.titre ?? [bien.typeBien, bien.ville].filter(Boolean).join(' à ') ?? 'Bien';
  // Clic tracké si on a un token (envoi réel), sinon lien direct (aperçu).
  const lien = token ? lienTracke(token) : lienAnnonce(bien);

  let messageHtml = esc(messageAgent).replace(/\n/g, '<br>');
  // {{lien}} → lien cliquable libellé ; puis on rend cliquable toute URL restante.
  messageHtml = messageHtml
    .replace(/\{\{\s*lien\s*\}\}/gi, `<a href="${lien}" style="color:#721C1F;text-decoration:underline;">Voir le bien et toutes les photos →</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" style="color:#721C1F;text-decoration:underline;">$2</a>');

  // Pixel d'ouverture (1×1 transparent) — seulement sur un envoi réel.
  const pixel = token
    ? `<img src="${config.appBaseUrl}/o?token=${encodeURIComponent(token)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">`
    : '';

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px;color:#222222;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;text-align:left;">
${messageHtml}
${photo ? `<div style="margin:16px 0;"><img src="${photo}" alt="${esc(titre)}" style="display:block;max-width:480px;width:100%;height:auto;"></div>` : ''}
<div style="margin-top:20px;color:#999999;font-size:12px;">Pour ne plus recevoir ce type de message, <a href="${unsubscribeUrl}" style="color:#999999;">cliquez ici</a>.</div>
${pixel}
</body></html>`;
}

/** Version texte (fallback deliverability). */
export function construireEmailTexte({ bien, messageAgent, unsubscribeUrl, token }: EmailParams): string {
  const lien = token ? lienTracke(token) : lienAnnonce(bien);
  const corps = messageAgent.replace(/\{\{\s*lien\s*\}\}/gi, lien);
  return [corps, '', `Se désinscrire : ${unsubscribeUrl}`].join('\n');
}
