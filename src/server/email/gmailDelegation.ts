import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { config } from '../config.ts';
import { buildRaw } from './gmailRaw.ts';

/**
 * Envoi Gmail par DÉLÉGATION DOMAINE (Google Workspace).
 *
 * Comme tous les agents sont dans l'org `matera.eu`, l'admin Workspace autorise
 * une fois un compte de service à « impersonate » n'importe quel utilisateur sur
 * le scope gmail.send. On envoie alors AU NOM de l'agent (subject = son email),
 * sans aucun token par agent ni connexion individuelle.
 *
 * Config admin (une fois) :
 *  - Compte de service + clé JSON (GOOGLE_SA_KEY_FILE ou GOOGLE_SA_KEY_JSON)
 *  - Admin console → Sécurité → Délégation au niveau du domaine → ajouter le
 *    client ID du compte de service avec le scope
 *    https://www.googleapis.com/auth/gmail.send
 */

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let saCache: ServiceAccount | null | undefined;

function chargerServiceAccount(): ServiceAccount | null {
  if (saCache !== undefined) return saCache;
  try {
    let brut: string | null = null;
    if (config.google.serviceAccountJson) brut = config.google.serviceAccountJson;
    else if (config.google.serviceAccountFile) brut = readFileSync(config.google.serviceAccountFile, 'utf8');
    if (!brut) { saCache = null; return null; }
    const sa = JSON.parse(brut) as ServiceAccount;
    saCache = sa.client_email && sa.private_key ? sa : null;
  } catch (e) {
    console.error('[gmail-delegation] clé compte de service illisible :', e instanceof Error ? e.message : e);
    saCache = null;
  }
  return saCache;
}

/** La délégation domaine est-elle configurée (clé de compte de service présente) ? */
export function delegationDisponible(): boolean {
  return chargerServiceAccount() !== null;
}

/** Envoie un email au nom de `agent` (impersonation via le compte de service). */
export async function envoyerViaGmailDelegation(
  agent: { email: string; nom: string },
  msg: { to: string; subject: string; html: string; text: string; unsubscribeUrl: string },
): Promise<{ messageId: string }> {
  const sa = chargerServiceAccount();
  if (!sa) throw new Error('Délégation domaine non configurée');

  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [SCOPE],
    subject: agent.email, // impersonation de l'agent
  });
  const gmail = google.gmail({ version: 'v1', auth: jwt });

  const resp = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: buildRaw({ fromName: agent.nom, fromEmail: agent.email, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, unsubscribeUrl: msg.unsubscribeUrl }) },
  });
  const id = resp.data.id;
  if (!id) throw new Error('Gmail (délégation) : réponse sans messageId');
  return { messageId: id };
}
