import { Router } from 'express';
import { config } from '../config.ts';
import { marquerOuverture, marquerClic, produitRefParToken } from '../db.ts';

export const trackingRouter = Router();

// GIF transparent 1×1 (servi au pixel d'ouverture).
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** URL de la landing page d'un bien (même schéma que template.lienAnnonce). */
function lpUrl(productRef: string): string {
  return `${config.lpBaseUrl}/modelo-${encodeURIComponent(productRef)}.html`;
}

/** Pixel d'ouverture : /o?token=… → marque l'ouverture, renvoie un GIF 1×1. */
trackingRouter.get('/o', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token) {
    try { marquerOuverture(token, new Date().toISOString()); } catch { /* best-effort */ }
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.end(PIXEL);
});

/** Redirection de clic : /c?token=… → marque le clic, 302 vers la landing page. */
trackingRouter.get('/c', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  let ref: string | null = null;
  if (token) {
    try {
      marquerClic(token, new Date().toISOString());
      ref = produitRefParToken(token);
    } catch { /* best-effort */ }
  }
  // Token inconnu → on renvoie quand même vers la base des annonces, jamais 404.
  res.redirect(302, ref ? lpUrl(ref) : config.lpBaseUrl);
});
