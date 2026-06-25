import pg from 'pg';
import { config } from '../config.ts';
import { decryptToken } from './tokenCrypto.ts';
import { getAgentGoogleLocal, premierAgentGoogleLocal } from '../db.ts';

/**
 * Accès en LECTURE SEULE à la base CRM partagée pour récupérer le refresh token
 * Google de l'agent (consenti lors de son login Google sur la plateforme Matera).
 * Le token est chiffré AES-256-GCM avec GOOGLE_TOKEN_SECRET — même schéma que
 * server-crm-immo/src/modules/acquereurs/services/gmail.service.ts.
 */

function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  return /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
}

let pool: pg.Pool | null = null;
function getPool(): pg.Pool | null {
  if (!config.crmDatabaseUrl) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.crmDatabaseUrl,
      ssl: sslFor(config.crmDatabaseUrl),
      max: 3,
    });
  }
  return pool;
}

export interface AgentGoogle {
  nom: string;
  email: string;
  refreshToken: string;
}

let colonneManquanteSignalee = false;

/**
 * Charge l'agent par email et renvoie son refresh token déchiffré, ou null si
 * agent inconnu / pas de token / base indisponible. Ne throw jamais.
 */
export async function chargerAgentGoogle(email: string | null): Promise<AgentGoogle | null> {
  const p = getPool();
  if (!p || !email) return null;
  try {
    const { rows } = await p.query<{ firstName: string; lastName: string; email: string; google_refresh_token: string | null }>(
      `SELECT "firstName", "lastName", email, "google_refresh_token"
         FROM crm.agents
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email.trim()],
    );
    if (rows.length === 0) return null;
    const token = decryptToken(rows[0].google_refresh_token);
    if (!token) return null;
    return {
      nom: [rows[0].firstName, rows[0].lastName].filter(Boolean).join(' ').trim() || rows[0].email,
      email: rows[0].email,
      refreshToken: token,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Colonne absente = base CRM non migrée (souvent un .env de dev) : cas géré,
    // on retombe sur Resend. On ne le signale qu'une fois pour ne pas spammer.
    if (msg.includes('google_refresh_token')) {
      if (!colonneManquanteSignalee) {
        colonneManquanteSignalee = true;
        console.warn('[crm] colonne google_refresh_token absente → CRM_DATABASE_URL doit pointer la base de PROD. Repli Resend.');
      }
      return null;
    }
    console.error('[crm] lecture agent Google échouée :', msg);
    return null;
  }
}

/**
 * Résout le token d'envoi d'un agent : d'abord la connexion in-app (SQLite),
 * sinon le CRM. C'est ce que la route d'envoi doit appeler.
 */
export async function resoudreAgentGoogle(email: string | null): Promise<AgentGoogle | null> {
  if (!email) return null;
  const local = getAgentGoogleLocal(email);
  if (local) {
    const token = decryptToken(local.refresh_token_enc);
    if (token) return { nom: local.nom ?? local.email, email: local.email, refreshToken: token };
  }
  return chargerAgentGoogle(email);
}

/**
 * Compte Google qui s'authentifie pour l'envoi (porteur du token) :
 *  1. COMPTE_ENVOI_EMAIL s'il est défini ;
 *  2. sinon le 1er compte connecté dans l'app ;
 *  3. sinon le token CRM de l'adresse d'expéditeur.
 * Le From affiché reste `config.expediteur` (alias send-as), géré par l'appelant.
 */
export async function resoudreCompteEnvoi(): Promise<AgentGoogle | null> {
  if (config.compteEnvoi) {
    const a = await resoudreAgentGoogle(config.compteEnvoi);
    if (a) return a;
  }
  const row = premierAgentGoogleLocal();
  if (row) {
    const token = decryptToken(row.refresh_token_enc);
    if (token) return { nom: row.nom ?? row.email, email: row.email, refreshToken: token };
  }
  return chargerAgentGoogle(config.expediteur.email);
}
