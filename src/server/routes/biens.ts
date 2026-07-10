import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.ts';
import {
  getBienDetecte, listBiensDetectes, setStatutBien, setBrouillon,
  listEnvois, recordEnvoi, emailDejaContactePourBien, emailContacteDepuis, listDesinscrits,
  enqueueEnvoi, planningBien, countFileEnAttente, listAgentsConnectes, statsCampagne, upsertBienDetecte,
  type BienDetecte, type StatutBien,
} from '../db.ts';
import { traiterFileAttente } from '../email/fileAttente.ts';
import { pollerModelo } from '../modelo/poller.ts';
import { reinitialiserThrottleModelo, fetchBienParRef, fetchExclusivitesParProduit } from '../modelo/client.ts';
import { rechercherCoprosVoisines, listerCoproprietaires, normaliserAdresse, type CoproVoisine } from '../omni/copros.ts';
import { geocodeAdresse } from '../geo/ban.ts';
import { genererBrouillonDefaut, construireEmailHtml, construireEmailTexte, rendreMessage, formatDistance, lienAnnonce } from '../email/template.ts';
import { resoudreCanal } from '../email/canal.ts';
import { verifierSession } from '../auth/session.ts';

export const biensRouter = Router();

/** Verrou anti double-clic : un seul envoi simultané par bien. */
const envoisEnCours = new Set<string>();

const now = () => new Date().toISOString();
/** Date (YYYY-MM-DD) dans N jours, en UTC. */
function dateDansNJours(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

interface CoproAvecContacts {
  commonholdId: string;
  address: string;
  postalCode: string | null;
  city: string | null;
  units: number | null;
  distanceKm: number | null;
  estCoproDuBien: boolean;
  coproprietaires: {
    email: string;
    prenom: string | null;
    nom: string | null;
    desinscrit: boolean;
    dejaContacte: boolean;
    recemmentContacte: boolean;
    eligible: boolean;
  }[];
}

/** Date ISO du début de la fenêtre de cooldown (now - cooldownJours). */
function debutCooldown(): string {
  return new Date(Date.now() - config.cooldownJours * 86_400_000).toISOString();
}

/** Trouve le centre géographique du bien (Modelo, sinon géocodage BAN). */
async function centreBien(b: BienDetecte['bien']): Promise<{ lat: number; lng: number } | null> {
  if (b.latitude != null && b.longitude != null) return { lat: b.latitude, lng: b.longitude };
  if (b.adresse && b.codePostal) {
    const geo = await geocodeAdresse(b.adresse, b.codePostal, b.ville ?? '');
    if (geo) return geo;
  }
  return null;
}

const SEUIL_MEME_POINT_KM = 0.02; // ~20 m : coordonnées quasi identiques (secours)

/** Sépare une adresse normalisée en { numéro de tête, reste = rue }. */
function decouperAdresse(adresseNorm: string): { num: number | null; rue: string } {
  const num = adresseNorm.match(/^\d+/)?.[0];
  const rue = adresseNorm.replace(/^[\d\s-]+/, '').trim();
  return { num: num ? Number(num) : null, rue };
}

/**
 * La copro correspond-elle au bâtiment du bien lui-même ?
 * Critère principal = MÊME ADRESSE (même rue + numéro identique/voisin, ce qui
 * gère « 15-17 » vs « 17 »). La distance ne sert qu'en secours quand les
 * coordonnées sont quasi confondues (≤20 m) — un simple « proche » ne suffit pas
 * (deux immeubles voisins de rues différentes ne sont pas la copro du bien).
 */
function estLeBatimentDuBien(c: CoproVoisine, bien: BienDetecte['bien']): boolean {
  const a = decouperAdresse(normaliserAdresse(bien.adresse));
  const b = decouperAdresse(normaliserAdresse(c.address));
  if (a.rue && b.rue && (b.rue.startsWith(a.rue) || a.rue.startsWith(b.rue))) {
    // Même rue : numéros égaux, voisins (≤2) ou non renseignés → même bâtiment.
    if (a.num === null || b.num === null || Math.abs(a.num - b.num) <= 2) return true;
  }
  return c.distanceKm != null && c.distanceKm <= SEUIL_MEME_POINT_KM;
}

/**
 * Calcule les copros cibles + leurs copropriétaires éligibles.
 * Si le bien est lui-même une copro Matera, elle est placée EN TÊTE puis
 * complétée par les `nbCoprosVoisines` plus proches (→ 6 au total). Sinon, les
 * `nbCoprosVoisines` plus proches (→ 5). Dédup déterministe dans cet ordre.
 */
async function calculerDestinataires(detecte: BienDetecte): Promise<{
  center: { lat: number; lng: number } | null;
  copros: CoproAvecContacts[];
}> {
  const b = detecte.bien;
  const center = await centreBien(b);
  // Recherche géographique (bounding box) dès qu'on a un centre ; sinon repli CP.
  if (!center && !b.codePostal) return { center: null, copros: [] };

  const nb = config.nbCoprosVoisines;
  const voisines = await rechercherCoprosVoisines({
    centerLat: center?.lat ?? null,
    centerLng: center?.lng ?? null,
    postalCode: b.codePostal,
    limit: nb + 2, // marge pour isoler la copro du bien des voisines
  });

  // Copro du bien (si c'est une copro Matera) en tête, puis les nb plus proches.
  const coproBien = voisines.find((c) => estLeBatimentDuBien(c, b)) ?? null;
  const autres = voisines.filter((c) => c !== coproBien).slice(0, nb);
  const choisies = coproBien ? [coproBien, ...autres] : autres;

  // 1) Copropriétaires de chaque copro (en parallèle, sans dédup).
  const contactsParCopro = await Promise.all(choisies.map((c) => listerCoproprietaires(c.commonholdId)));

  // 2) Dédup déterministe dans l'ordre (copro du bien prioritaire) + exclusions.
  const desinscrits = listDesinscrits();
  const depuis = debutCooldown();
  const dejaVu = new Set<string>();
  const copros: CoproAvecContacts[] = choisies.map((c, i) => ({
    commonholdId: c.commonholdId,
    address: c.address,
    postalCode: c.postalCode,
    city: c.city,
    units: c.units,
    distanceKm: c.distanceKm,
    estCoproDuBien: c === coproBien,
    coproprietaires: contactsParCopro[i].map((g) => {
      const desinscrit = desinscrits.has(g.email);
      const dejaContacte = emailDejaContactePourBien(detecte.productRef, g.email);
      const recemmentContacte = emailContacteDepuis(g.email, depuis);
      const doublon = dejaVu.has(g.email);
      const eligible = !desinscrit && !dejaContacte && !recemmentContacte && !doublon;
      if (eligible) dejaVu.add(g.email);
      return { email: g.email, prenom: g.prenom, nom: g.nom, desinscrit, dejaContacte, recemmentContacte, eligible };
    }),
  }));

  return { center, copros };
}

// ── Liste des biens détectés ───────────────────────────────────────────
biensRouter.get('/biens', (req, res) => {
  const statut = req.query.statut as StatutBien | undefined;
  res.json(listBiensDetectes(statut));
});

// ── Détail d'un bien + destinataires calculés ──────────────────────────
biensRouter.get('/biens/:ref', async (req, res) => {
  const detecte = getBienDetecte(req.params.ref);
  if (!detecte) return res.status(404).json({ error: 'Bien introuvable' });
  try {
    const { center, copros } = await calculerDestinataires(detecte);
    const brouillon = detecte.sujet && detecte.messageAgent
      ? { sujet: detecte.sujet, message: detecte.messageAgent }
      : genererBrouillonDefaut(detecte.bien);
    const nbEligibles = copros.reduce(
      (n, c) => n + c.coproprietaires.filter((p) => p.eligible).length, 0,
    );
    // D'où partira le mail (délégation domaine → token agent → Resend).
    const c = await resoudreCanal();
    const expedition = { canal: c.canal, source: c.source, expediteur: c.expediteur };
    res.json({ detecte, brouillon, center, copros, nbEligibles, expedition, lienAnnonce: lienAnnonce(detecte.bien), stats: statsCampagne(req.params.ref) });
  } catch (e) {
    res.status(502).json({ error: `Omni : ${(e as Error).message}` });
  }
});

// ── Aperçu HTML de l'email (live, avec le message tapé) ─────────────────
const previewSchema = z.object({ message: z.string() });
biensRouter.post('/biens/:ref/preview', (req, res) => {
  const detecte = getBienDetecte(req.params.ref);
  if (!detecte) return res.status(404).json({ error: 'Bien introuvable' });
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'message requis' });
  const html = construireEmailHtml({
    bien: detecte.bien,
    messageAgent: rendreMessage(parsed.data.message, 'proximité'),
    unsubscribeUrl: '#apercu-desinscription',
  });
  res.json({ html });
});

// ── Enregistrer le brouillon ───────────────────────────────────────────
const brouillonSchema = z.object({ sujet: z.string().min(1), message: z.string().min(1) });
biensRouter.post('/biens/:ref/brouillon', (req, res) => {
  const detecte = getBienDetecte(req.params.ref);
  if (!detecte) return res.status(404).json({ error: 'Bien introuvable' });
  const parsed = brouillonSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'sujet et message requis' });
  setBrouillon(req.params.ref, parsed.data.sujet, parsed.data.message, now());
  res.json({ ok: true });
});

// ── Email de test à SOI-MÊME (l'utilisateur connecté) ───────────────────
// Distinct de la campagne : un seul mail, vers l'email de la session SSO,
// sans toucher la file ni les stats (pas de token de tracking, pas de recordEnvoi).
const testSchema = z.object({ sujet: z.string().min(1), message: z.string().min(1) });
biensRouter.post('/biens/:ref/test', async (req, res) => {
  const detecte = getBienDetecte(req.params.ref);
  if (!detecte) return res.status(404).json({ error: 'Bien introuvable' });
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'sujet et message requis' });
  // Destinataire = utilisateur connecté (session SSO) ; repli sur l'adresse de test.
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const moi = verifierSession(bearer)?.email ?? config.testRecipient;
  if (!moi) return res.status(400).json({ error: 'Connecte-toi en SSO pour recevoir un email de test.' });
  const canalEnvoi = await resoudreCanal();
  if (!canalEnvoi.envoyer) {
    return res.status(400).json({ error: `Aucun canal d'envoi (ni délégation domaine, ni token Google, ni Resend).` });
  }
  const messageRendu = rendreMessage(parsed.data.message, formatDistance(0.2));
  // Jeton factice : routes/optout.ts sert une page « aperçu » pour ce token.
  const unsubscribeUrl = `${config.appBaseUrl}/desinscription?token=apercu`;
  const html = construireEmailHtml({ bien: detecte.bien, messageAgent: messageRendu, unsubscribeUrl });
  const text = construireEmailTexte({ bien: detecte.bien, messageAgent: messageRendu, unsubscribeUrl });
  try {
    await canalEnvoi.envoyer({ to: moi, subject: `[ESSAI] ${parsed.data.sujet}`, html, text, unsubscribeUrl });
    res.json({ ok: true, destinataire: moi });
  } catch (e) {
    res.status(502).json({ error: `Échec de l'envoi : ${(e as Error).message}` });
  }
});

// ── Inclure manuellement un bien par référence (contourne off-market/récence) ──
// Pour les exceptions : un bien déjà diffusé ou trop ancien que le détecteur
// n'ajoute pas. On le récupère chez Modelo et on l'insère en statut « nouveau ».
biensRouter.post('/biens/:ref/inclure', async (req, res) => {
  const ref = req.params.ref.trim();
  let bien;
  try {
    bien = await fetchBienParRef(ref);
  } catch (e) {
    return res.status(502).json({ error: `Modelo : ${(e as Error).message}` });
  }
  if (!bien) return res.status(404).json({ error: `Bien ${ref} introuvable chez Modelo (ou supprimé).` });
  // Type de mandat (best-effort — ne bloque pas l'inclusion si l'appel échoue).
  const excl = await fetchExclusivitesParProduit(new Set([bien.productRef])).catch(() => null);
  if (excl) bien.mandatType = excl.get(bien.productRef) ?? null;
  const nouveau = upsertBienDetecte(bien, now());
  res.json({ ok: true, nouveau, ref: bien.productRef, adresse: bien.adresse, mandatType: bien.mandatType, diffuse: bien.diffuse, nbPortails: bien.nbPortails });
});

// ── Changer le statut (ignorer / réactiver) ─────────────────────────────
const statutSchema = z.object({ statut: z.enum(['nouveau', 'envoye', 'ignore']) });
biensRouter.post('/biens/:ref/statut', (req, res) => {
  const detecte = getBienDetecte(req.params.ref);
  if (!detecte) return res.status(404).json({ error: 'Bien introuvable' });
  const parsed = statutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'statut invalide' });
  setStatutBien(req.params.ref, parsed.data.statut, now());
  res.json({ ok: true });
});

// ── Envoi (validé par l'agent) ──────────────────────────────────────────
const envoyerSchema = z.object({
  sujet: z.string().min(1),
  message: z.string().min(1),
  destinataires: z.array(z.object({
    email: z.string().email(),
    prenom: z.string().nullable().optional(),
    nom: z.string().nullable().optional(),
    commonholdId: z.string().nullable().optional(),
    coproAdresse: z.string().nullable().optional(),
    distanceKm: z.number().nullable().optional(),
  })).min(1),
});

biensRouter.post('/biens/:ref/envoyer', async (req, res) => {
  const detecte = getBienDetecte(req.params.ref);
  if (!detecte) return res.status(404).json({ error: 'Bien introuvable' });

  // Deux requêtes concurrentes (double-clic) passeraient toutes deux les filtres
  // avant le 1er insert → double-envoi. Un verrou par bien le neutralise.
  if (envoisEnCours.has(req.params.ref)) {
    return res.status(409).json({ error: 'Un envoi est déjà en cours pour ce bien.' });
  }
  envoisEnCours.add(req.params.ref);
  try {
  const parsed = envoyerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Données d\'envoi invalides', details: parsed.error.flatten() });
  const { sujet, message, destinataires } = parsed.data;

  // Canal d'envoi : délégation domaine → token agent → Resend.
  const canalEnvoi = await resoudreCanal();
  if (!canalEnvoi.envoyer) {
    return res.status(400).json({
      error: `Aucun canal d'envoi pour l'agent ${detecte.bien.agentEmail ?? '?'} (ni délégation domaine, ni token Google, ni Resend).`,
    });
  }

  // Persiste le brouillon validé.
  setBrouillon(req.params.ref, sujet, message, now());

  // Filtre serveur : désinscrits, déjà-contactés (ce bien), cooldown, doublons.
  const desinscrits = listDesinscrits();
  const depuis = debutCooldown();
  const vus = new Set<string>();
  const valides: typeof destinataires = [];
  let ignores = 0;
  for (const d of destinataires) {
    const email = d.email.toLowerCase();
    if (vus.has(email)) continue;
    vus.add(email);
    if (desinscrits.has(email) || emailDejaContactePourBien(req.params.ref, email) || emailContacteDepuis(email, depuis)) {
      ignores++; continue;
    }
    valides.push({ ...d, email });
  }

  // Envoi immédiat d'un destinataire (1er lot). Renvoie le statut.
  const envoyerUn = async (d: typeof destinataires[number]): Promise<'envoye' | 'test' | 'erreur'> => {
    const email = d.email.toLowerCase();
    const token = randomUUID();
    const unsubscribeUrl = `${config.appBaseUrl}/desinscription?token=${token}`;
    const messageRendu = rendreMessage(message, formatDistance(d.distanceKm));
    const html = construireEmailHtml({ bien: detecte.bien, messageAgent: messageRendu, unsubscribeUrl, token });
    const text = construireEmailTexte({ bien: detecte.bien, messageAgent: messageRendu, unsubscribeUrl, token });
    const destinataireReel = config.sandbox ? config.testRecipient : email;
    const sujetFinal = config.sandbox ? `[TEST → ${email}] ${sujet}` : sujet;
    const base = {
      product_ref: req.params.ref, email, commonhold_id: d.commonholdId ?? null,
      copro_adresse: d.coproAdresse ?? null, prenom: d.prenom ?? null, nom: d.nom ?? null, token,
    };
    try {
      const { messageId } = await canalEnvoi.envoyer!({ to: destinataireReel, subject: sujetFinal, html, text, unsubscribeUrl });
      const statut = config.sandbox ? 'test' : 'envoye';
      recordEnvoi({ ...base, statut, message_id: messageId, erreur: null, sent_at: now() });
      return statut;
    } catch (e) {
      recordEnvoi({ ...base, statut: 'erreur', message_id: null, erreur: (e as Error).message, sent_at: now() });
      return 'erreur';
    }
  };

  // Mode réel : TOUT part en file (lots de tailleLot par jour, 1er lot daté
  // d'aujourd'hui), puis on déclenche un drain — la tranche de l'heure part
  // tout de suite si la fenêtre (9h-18h Paris, jours ouvrés) est ouverte, le
  // reste s'étale heure par heure via le cron. Rien ne part d'un coup et le
  // cap journalier global est respecté même en validant plusieurs campagnes.
  // Sandbox : 1er lot envoyé immédiatement (mails de test), reste programmé.
  const taille = config.tailleLot;
  const programmer = (d: typeof valides[number], jour: string) => enqueueEnvoi({
    product_ref: req.params.ref, email: d.email.toLowerCase(), prenom: d.prenom ?? null, nom: d.nom ?? null,
    commonhold_id: d.commonholdId ?? null, copro_adresse: d.coproAdresse ?? null, distance_km: d.distanceKm ?? null,
    sujet, message, jour_prevu: jour, created_at: now(),
  });
  let envoyes = 0, tests = 0, erreurs = 0;
  if (config.sandbox) {
    for (const d of valides.slice(0, taille)) {
      const s = await envoyerUn(d);
      if (s === 'envoye') envoyes++; else if (s === 'test') tests++; else erreurs++;
    }
    valides.slice(taille).forEach((d, i) => programmer(d, dateDansNJours(Math.floor(i / taille) + 1)));
  } else {
    valides.forEach((d, i) => programmer(d, dateDansNJours(Math.floor(i / taille))));
    // NB : le drain traite la file GLOBALE (toutes campagnes dues confondues).
    const drain = await traiterFileAttente();
    envoyes = drain.envoyes; erreurs = drain.erreurs;
  }

  if (!config.sandbox && valides.length > 0) setStatutBien(req.params.ref, 'envoye', now());

  const planning = planningBien(req.params.ref);
  res.json({
    sandbox: config.sandbox, canal: canalEnvoi.canal, source: canalEnvoi.source, expediteur: canalEnvoi.expediteur,
    envoyes, tests, erreurs, ignores, programmes: planning.reduce((s, p) => s + p.count, 0), planning,
  });
  } finally {
    envoisEnCours.delete(req.params.ref);
  }
});

// ── Journal des envois ──────────────────────────────────────────────────
biensRouter.get('/envois', (req, res) => {
  res.json(listEnvois(req.query.ref as string | undefined));
});

// ── Agents ayant connecté leur Google (in-app) ──────────────────────────
biensRouter.get('/agents-connectes', (_req, res) => {
  res.json(listAgentsConnectes());
});

// ── File d'attente : état + déclenchement manuel (test) ─────────────────
biensRouter.get('/file', (_req, res) => {
  res.json({ enAttente: countFileEnAttente() });
});
biensRouter.post('/file/traiter', async (_req, res) => {
  res.json(await traiterFileAttente());
});

// ── Déclenchement manuel d'un poll Modelo ───────────────────────────────
biensRouter.post('/poll', async (_req, res) => {
  try {
    // Poll lancé par un humain : on lève le circuit-breaker pour forcer un
    // essai réel même si la clé était throttlée (un seul appel sera tenté ;
    // s'il échoue, le breaker se ré-arme tout seul).
    reinitialiserThrottleModelo();
    const r = await pollerModelo();
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: `Modelo : ${(e as Error).message}` });
  }
});
