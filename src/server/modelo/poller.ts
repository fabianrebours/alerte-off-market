import cron from 'node-cron';
import { fetchBiensSurLeMarche, fetchExclusivitesParProduit, type MandatType } from './client.ts';
import { config } from '../config.ts';
import { upsertBienDetecte, majSnapshotSiExiste } from '../db.ts';

/**
 * Poll Modelo :
 *  - RAFRAÎCHIT le snapshot de tous les biens state=1 déjà suivis (prix, photos,
 *    coordonnées agent…), même hors fenêtre de récence — sinon un bien suivi
 *    garde des données périmées.
 *  - INSÈRE les nouveaux biens **off-market récents** (non diffusés, créés
 *    depuis ≤ recenceJours, avec ou sans photo). Le filtre de récence évite de
 *    remonter les biens qui datent — pas de « baseline » au 1er passage.
 */
export async function pollerModelo(): Promise<{ nouveaux: number; total: number }> {
  const tous = await fetchBiensSurLeMarche(); // tous les state=1 vivants
  const now = new Date().toISOString();

  // Type de mandat (exclusif/simple) — lu sur /mandates (champ exclusivity).
  // Activable/désactivable via MODELO_AFFAIRS=1. Sinon mandatType reste null
  // (badge masqué). En repli silencieux si l'appel échoue.
  if (config.modelo.affairs) {
    const refs = new Set(tous.map((b) => b.productRef));
    const exclusivites = await fetchExclusivitesParProduit(refs).catch((e) => {
      console.warn('[poller] exclusivités indisponibles :', e instanceof Error ? e.message : e);
      return new Map<string, MandatType>();
    });
    for (const b of tous) b.mandatType = exclusivites.get(b.productRef) ?? null;
  }

  // Rafraîchit les snapshots des biens déjà en base.
  for (const b of tous) majSnapshotSiExiste(b, now);

  // Nouveaux candidats : off-market + récents.
  const limite = Date.now() - config.recenceJours * 86_400_000;
  const candidats = tous.filter((b) => {
    if (b.diffuse || !b.dateCreation) return false;
    const t = new Date(b.dateCreation).getTime();
    return Number.isFinite(t) && t >= limite;
  });

  let nouveaux = 0;
  for (const b of candidats) {
    if (upsertBienDetecte(b, now)) nouveaux++;
  }

  console.log(`[poller] ${nouveaux} nouveau(x) bien(s) off-market · ${candidats.length} candidat(s) récents · ${tous.length} biens rafraîchis.`);
  return { nouveaux, total: candidats.length };
}

/**
 * Démarre le cron Modelo : UN passage par jour à 06:00.
 * Cadence volontairement basse — l'API Netty throttle vite (la détection
 * off-market n'a pas besoin d'être temps réel). Pour un poll immédiat, utiliser
 * le bouton « Rafraîchir Modelo » (POST /api/poll). Pas de poll au démarrage
 * (évite de taper l'API à chaque redémarrage).
 */
export function demarrerCronModelo(): void {
  cron.schedule('0 6 * * *', () => {
    pollerModelo().catch((e) => console.error('[poller] échec :', e instanceof Error ? e.message : e));
  });
  console.log('[poller] cron Modelo armé (tous les jours à 06:00).');
}
