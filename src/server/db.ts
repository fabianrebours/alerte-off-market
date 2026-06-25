import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BienModelo } from './modelo/types.ts';

/**
 * Persistance SQLite (zéro infra). 3 tables :
 *  - biens_detectes : un bien Modelo repéré « sur le marché » + brouillon agent.
 *  - envois         : trace RGPD de chaque mail envoyé (1 ligne / destinataire).
 *  - desinscriptions: opt-out, exclu des futurs envois.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(here, '../../data/app.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Le fichier contient des données perso (emails/noms) : lecture/écriture proprio seul.
try {
  chmodSync(DB_PATH, 0o600);
  for (const suffixe of ['-wal', '-shm']) {
    try { chmodSync(DB_PATH + suffixe, 0o600); } catch { /* pas encore créé */ }
  }
} catch { /* best-effort : FS sans permissions POSIX */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS biens_detectes (
    product_ref   TEXT PRIMARY KEY,
    detected_at   TEXT NOT NULL,
    has_photo     INTEGER NOT NULL DEFAULT 0,
    snapshot_json TEXT NOT NULL,
    statut        TEXT NOT NULL DEFAULT 'nouveau',   -- nouveau | envoye | ignore
    sujet         TEXT,
    message_agent TEXT,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS envois (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_ref   TEXT NOT NULL,
    email         TEXT NOT NULL,
    commonhold_id TEXT,
    copro_adresse TEXT,
    prenom        TEXT,
    nom           TEXT,
    token         TEXT NOT NULL,
    statut        TEXT NOT NULL,                      -- envoye | erreur
    message_id    TEXT,
    erreur        TEXT,
    sent_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_envois_ref ON envois(product_ref);
  CREATE INDEX IF NOT EXISTS idx_envois_token ON envois(token);

  CREATE TABLE IF NOT EXISTS desinscriptions (
    email           TEXT PRIMARY KEY,
    unsubscribed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_google (
    email             TEXT PRIMARY KEY,   -- email Matera de l'agent (lower)
    nom               TEXT,
    refresh_token_enc TEXT NOT NULL,      -- chiffré AES-256-GCM (enc:iv:tag:data)
    connected_at      TEXT NOT NULL
  );

  -- File d'attente : envois étalés (max 30/jour par campagne).
  CREATE TABLE IF NOT EXISTS file_attente (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_ref   TEXT NOT NULL,
    email         TEXT NOT NULL,
    prenom        TEXT,
    nom           TEXT,
    commonhold_id TEXT,
    copro_adresse TEXT,
    distance_km   REAL,
    sujet         TEXT NOT NULL,
    message       TEXT NOT NULL,
    jour_prevu    TEXT NOT NULL,          -- date YYYY-MM-DD à partir de laquelle envoyer
    statut        TEXT NOT NULL DEFAULT 'en_attente', -- en_attente | envoye | erreur | annule
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_file_due ON file_attente(statut, jour_prevu);
  CREATE INDEX IF NOT EXISTS idx_file_ref ON file_attente(product_ref);
`);

// Migration douce : ajoute distance_km aux bases file_attente créées avant.
{
  const cols = db.prepare("PRAGMA table_info(file_attente)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'distance_km')) {
    db.exec('ALTER TABLE file_attente ADD COLUMN distance_km REAL');
  }
}

export type StatutBien = 'nouveau' | 'envoye' | 'ignore';

export interface BienDetecteRow {
  product_ref: string;
  detected_at: string;
  has_photo: number;
  snapshot_json: string;
  statut: StatutBien;
  sujet: string | null;
  message_agent: string | null;
  updated_at: string;
}

export interface BienDetecte {
  productRef: string;
  detectedAt: string;
  hasPhoto: boolean;
  statut: StatutBien;
  sujet: string | null;
  messageAgent: string | null;
  updatedAt: string;
  bien: BienModelo;
  /** Mails déjà partis (réels + tests). */
  nbEnvoyes: number;
  /** Mails encore programmés en file d'attente. */
  nbEnAttente: number;
}

function mapBien(row: BienDetecteRow): BienDetecte {
  return {
    productRef: row.product_ref,
    detectedAt: row.detected_at,
    hasPhoto: row.has_photo === 1,
    statut: row.statut,
    sujet: row.sujet,
    messageAgent: row.message_agent,
    updatedAt: row.updated_at,
    bien: JSON.parse(row.snapshot_json) as BienModelo,
    nbEnvoyes: countEnvoisDispatched(row.product_ref),
    nbEnAttente: countFilePourBien(row.product_ref),
  };
}

const stmtGetBien = db.prepare<[string], BienDetecteRow>('SELECT * FROM biens_detectes WHERE product_ref = ?');
const stmtCountEnvois = db.prepare<[string], { n: number }>(
  "SELECT COUNT(*) AS n FROM envois WHERE product_ref = ? AND statut = 'envoye'",
);

export function countEnvoisEnvoyes(productRef: string): number {
  return stmtCountEnvois.get(productRef)?.n ?? 0;
}

/** Mails effectivement partis pour ce bien (réels + tests). */
export function countEnvoisDispatched(productRef: string): number {
  return db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM envois WHERE product_ref = ? AND statut IN ('envoye','test')",
  ).get(productRef)?.n ?? 0;
}

/** Mails encore en file d'attente (programmés) pour ce bien. */
export function countFilePourBien(productRef: string): number {
  return db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM file_attente WHERE product_ref = ? AND statut = 'en_attente'",
  ).get(productRef)?.n ?? 0;
}

/** Upsert d'un bien détecté. Renvoie true si c'est une nouvelle détection. */
export function upsertBienDetecte(b: BienModelo, nowIso: string): boolean {
  const existant = stmtGetBien.get(b.productRef);
  if (existant) {
    // On rafraîchit le snapshot (prix/photos peuvent évoluer) sans toucher au statut/brouillon.
    db.prepare('UPDATE biens_detectes SET snapshot_json = ?, has_photo = ?, updated_at = ? WHERE product_ref = ?')
      .run(JSON.stringify(b), b.photos.length > 0 ? 1 : 0, nowIso, b.productRef);
    return false;
  }
  db.prepare(
    `INSERT INTO biens_detectes (product_ref, detected_at, has_photo, snapshot_json, statut, updated_at)
     VALUES (?, ?, ?, ?, 'nouveau', ?)`,
  ).run(b.productRef, nowIso, b.photos.length > 0 ? 1 : 0, JSON.stringify(b), nowIso);
  return true;
}

/** Rafraîchit le snapshot d'un bien DÉJÀ suivi (no-op s'il n'existe pas). */
export function majSnapshotSiExiste(b: BienModelo, nowIso: string): void {
  db.prepare('UPDATE biens_detectes SET snapshot_json = ?, has_photo = ?, updated_at = ? WHERE product_ref = ?')
    .run(JSON.stringify(b), b.photos.length > 0 ? 1 : 0, nowIso, b.productRef);
}

export function getBienDetecte(productRef: string): BienDetecte | null {
  const row = stmtGetBien.get(productRef);
  return row ? mapBien(row) : null;
}

export function listBiensDetectes(statut?: StatutBien): BienDetecte[] {
  const rows = statut
    ? db.prepare<[string], BienDetecteRow>('SELECT * FROM biens_detectes WHERE statut = ? ORDER BY detected_at DESC').all(statut)
    : db.prepare<[], BienDetecteRow>('SELECT * FROM biens_detectes ORDER BY detected_at DESC').all();
  return rows.map(mapBien);
}

export function setStatutBien(productRef: string, statut: StatutBien, nowIso: string): void {
  db.prepare('UPDATE biens_detectes SET statut = ?, updated_at = ? WHERE product_ref = ?')
    .run(statut, nowIso, productRef);
}

export function setBrouillon(productRef: string, sujet: string, message: string, nowIso: string): void {
  db.prepare('UPDATE biens_detectes SET sujet = ?, message_agent = ?, updated_at = ? WHERE product_ref = ?')
    .run(sujet, message, nowIso, productRef);
}

export interface EnvoiRow {
  id: number;
  product_ref: string;
  email: string;
  commonhold_id: string | null;
  copro_adresse: string | null;
  prenom: string | null;
  nom: string | null;
  token: string;
  statut: 'envoye' | 'erreur' | 'test';
  message_id: string | null;
  erreur: string | null;
  sent_at: string;
}

export function recordEnvoi(e: Omit<EnvoiRow, 'id'>): void {
  db.prepare(
    `INSERT INTO envois (product_ref, email, commonhold_id, copro_adresse, prenom, nom, token, statut, message_id, erreur, sent_at)
     VALUES (@product_ref, @email, @commonhold_id, @copro_adresse, @prenom, @nom, @token, @statut, @message_id, @erreur, @sent_at)`,
  ).run(e);
}

export function listEnvois(productRef?: string): EnvoiRow[] {
  return productRef
    ? db.prepare<[string], EnvoiRow>('SELECT * FROM envois WHERE product_ref = ? ORDER BY sent_at DESC').all(productRef)
    : db.prepare<[], EnvoiRow>('SELECT * FROM envois ORDER BY sent_at DESC LIMIT 500').all();
}

export function emailDejaContactePourBien(productRef: string, email: string): boolean {
  const row = db.prepare<[string, string], { n: number }>(
    "SELECT COUNT(*) AS n FROM envois WHERE product_ref = ? AND email = ? AND statut = 'envoye'",
  ).get(productRef, email.toLowerCase());
  return (row?.n ?? 0) > 0;
}

/** A-t-on déjà envoyé un mail (réel) à cette personne depuis `depuisIso` ? (cooldown anti-spam) */
export function emailContacteDepuis(email: string, depuisIso: string): boolean {
  const row = db.prepare<[string, string], { n: number }>(
    "SELECT COUNT(*) AS n FROM envois WHERE email = ? AND statut = 'envoye' AND sent_at >= ?",
  ).get(email.toLowerCase(), depuisIso);
  return (row?.n ?? 0) > 0;
}

// ── Désinscriptions (opt-out) ──────────────────────────────────────────
export function listDesinscrits(): Set<string> {
  const rows = db.prepare<[], { email: string }>('SELECT email FROM desinscriptions').all();
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

export function estDesinscrit(email: string): boolean {
  return !!db.prepare<[string], { email: string }>('SELECT email FROM desinscriptions WHERE email = ?')
    .get(email.toLowerCase());
}

export function ajouterDesinscription(email: string, nowIso: string): void {
  db.prepare('INSERT OR IGNORE INTO desinscriptions (email, unsubscribed_at) VALUES (?, ?)')
    .run(email.toLowerCase(), nowIso);
}

export function emailParToken(token: string): string | null {
  const row = db.prepare<[string], { email: string }>('SELECT email FROM envois WHERE token = ? LIMIT 1').get(token);
  return row?.email ?? null;
}

// ── Tokens Google des agents (connexion in-app) ─────────────────────────
export interface AgentGoogleRow {
  email: string;
  nom: string | null;
  refresh_token_enc: string;
  connected_at: string;
}

export function upsertAgentGoogle(email: string, nom: string | null, refreshTokenEnc: string, nowIso: string): void {
  db.prepare(
    `INSERT INTO agent_google (email, nom, refresh_token_enc, connected_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET nom = excluded.nom, refresh_token_enc = excluded.refresh_token_enc, connected_at = excluded.connected_at`,
  ).run(email.toLowerCase(), nom, refreshTokenEnc, nowIso);
}

export function getAgentGoogleLocal(email: string): AgentGoogleRow | null {
  return db.prepare<[string], AgentGoogleRow>('SELECT * FROM agent_google WHERE email = ?').get(email.toLowerCase()) ?? null;
}

/** Premier compte Google connecté (le plus ancien) — compte d'envoi par défaut. */
export function premierAgentGoogleLocal(): AgentGoogleRow | null {
  return db.prepare<[], AgentGoogleRow>('SELECT * FROM agent_google ORDER BY connected_at LIMIT 1').get() ?? null;
}

export function listAgentsConnectes(): { email: string; nom: string | null; connectedAt: string }[] {
  return db.prepare<[], AgentGoogleRow>('SELECT email, nom, refresh_token_enc, connected_at FROM agent_google ORDER BY email').all()
    .map((r) => ({ email: r.email, nom: r.nom, connectedAt: r.connected_at }));
}

// ── File d'attente d'envois (étalement 30/jour) ─────────────────────────
export interface FileAttenteRow {
  id: number;
  product_ref: string;
  email: string;
  prenom: string | null;
  nom: string | null;
  commonhold_id: string | null;
  copro_adresse: string | null;
  distance_km: number | null;
  sujet: string;
  message: string;
  jour_prevu: string;
  statut: 'en_attente' | 'en_cours' | 'envoye' | 'erreur' | 'annule';
  created_at: string;
}

export function enqueueEnvoi(e: Omit<FileAttenteRow, 'id' | 'statut'>): void {
  db.prepare(
    `INSERT INTO file_attente (product_ref, email, prenom, nom, commonhold_id, copro_adresse, distance_km, sujet, message, jour_prevu, statut, created_at)
     VALUES (@product_ref, @email, @prenom, @nom, @commonhold_id, @copro_adresse, @distance_km, @sujet, @message, @jour_prevu, 'en_attente', @created_at)`,
  ).run(e);
}

/** Lignes en attente dont le jour prévu est <= dateJour (YYYY-MM-DD). */
export function fileDue(dateJour: string): FileAttenteRow[] {
  return db.prepare<[string], FileAttenteRow>(
    "SELECT * FROM file_attente WHERE statut = 'en_attente' AND jour_prevu <= ? ORDER BY jour_prevu, id",
  ).all(dateJour);
}

export function marquerFile(id: number, statut: FileAttenteRow['statut']): void {
  db.prepare('UPDATE file_attente SET statut = ? WHERE id = ?').run(statut, id);
}

/**
 * Réserve atomiquement une ligne pour envoi (en_attente → en_cours).
 * Renvoie true si C'EST CE process qui l'a prise — deux drains concurrents ne
 * peuvent pas réserver la même ligne (anti double-envoi).
 */
export function reserverFile(id: number): boolean {
  return db.prepare("UPDATE file_attente SET statut = 'en_cours' WHERE id = ? AND statut = 'en_attente'")
    .run(id).changes === 1;
}

/** Remet en file les lignes 'en_cours' orphelines (run précédent interrompu). */
export function reclamerFileEnCours(): number {
  return db.prepare("UPDATE file_attente SET statut = 'en_attente' WHERE statut = 'en_cours'").run().changes;
}

/** Nombre d'emails réellement partis (réels + tests) à la date YYYY-MM-DD — pour le cap journalier. */
export function countEnvoisDuJour(dateJour: string): number {
  return db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM envois WHERE statut IN ('envoye','test') AND substr(sent_at, 1, 10) = ?",
  ).get(dateJour)?.n ?? 0;
}

/** Enregistre l'envoi ET marque la ligne de file, atomiquement (anti-incohérence au crash). */
export const finaliserLigneFile = db.transaction(
  (envoi: Omit<EnvoiRow, 'id'>, fileId: number, statutFile: FileAttenteRow['statut']) => {
    recordEnvoi(envoi);
    marquerFile(fileId, statutFile);
  },
);

/** Récapitulatif des envois programmés (par date) pour un bien. */
export function planningBien(productRef: string): { jour: string; count: number }[] {
  return db.prepare<[string], { jour: string; count: number }>(
    "SELECT jour_prevu AS jour, COUNT(*) AS count FROM file_attente WHERE product_ref = ? AND statut = 'en_attente' GROUP BY jour_prevu ORDER BY jour_prevu",
  ).all(productRef);
}

export function countFileEnAttente(): number {
  return db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM file_attente WHERE statut = 'en_attente'").get()?.n ?? 0;
}
