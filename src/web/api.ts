// Couche API typée — miroir des routes Express.

export interface BienModelo {
  productRef: string;
  titre: string | null;
  typeBien: string | null;
  adresse: string | null;
  codePostal: string | null;
  ville: string | null;
  latitude: number | null;
  longitude: number | null;
  surface: number | null;
  pieces: number | null;
  chambres: number | null;
  etage: number | null;
  prix: number | null;
  description: string | null;
  dpeLettre: string | null;
  gesLettre: string | null;
  photos: string[];
  agentEmail: string | null;
  agentNom: string | null;
  agentTelephone: string | null;
  state: number;
  mandatType: 'simple' | 'semi_exclusif' | 'exclusif' | 'delegation' | null;
  dateCreation: string | null;
  diffuse: boolean;
  nbPortails: number;
}

export type StatutBien = 'nouveau' | 'envoye' | 'ignore';

export interface BienDetecte {
  productRef: string;
  detectedAt: string;
  hasPhoto: boolean;
  statut: StatutBien;
  sujet: string | null;
  messageAgent: string | null;
  updatedAt: string;
  bien: BienModelo;
  nbEnvoyes: number;
  nbEnAttente: number;
}

export interface Coproprietaire {
  email: string;
  prenom: string | null;
  nom: string | null;
  desinscrit: boolean;
  dejaContacte: boolean;
  recemmentContacte: boolean;
  eligible: boolean;
}

export interface CoproAvecContacts {
  commonholdId: string;
  address: string;
  postalCode: string | null;
  city: string | null;
  units: number | null;
  distanceKm: number | null;
  estCoproDuBien: boolean;
  coproprietaires: Coproprietaire[];
}

export interface Expedition {
  canal: 'gmail' | 'resend' | 'aucun';
  source: 'delegation' | 'token' | 'resend' | null;
  expediteur: string | null;
}

export interface StatsCampagne {
  envoyes: number;
  ouverts: number;
  cliques: number;
}

export interface DetailReponse {
  detecte: BienDetecte;
  brouillon: { sujet: string; message: string };
  center: { lat: number; lng: number } | null;
  copros: CoproAvecContacts[];
  nbEligibles: number;
  expedition: Expedition;
  lienAnnonce: string;
  stats: StatsCampagne;
}

export interface Envoi {
  id: number;
  product_ref: string;
  email: string;
  copro_adresse: string | null;
  prenom: string | null;
  nom: string | null;
  statut: 'envoye' | 'erreur' | 'test';
  message_id: string | null;
  erreur: string | null;
  sent_at: string;
}

export interface AgentConnecte {
  email: string;
  nom: string | null;
  connectedAt: string;
}

export interface StatutIntegrations {
  modelo: boolean;
  omni: boolean;
  resend: boolean;
  gmailAgent: boolean;
  gmailDelegation: boolean;
  sandbox: boolean;
  nbCoprosVoisines: number;
}

export interface DestinataireEnvoi {
  email: string;
  prenom: string | null;
  nom: string | null;
  commonholdId: string | null;
  coproAdresse: string | null;
  distanceKm: number | null;
}

export interface ResultatEnvoi {
  sandbox: boolean;
  canal: 'gmail' | 'resend';
  source: 'delegation' | 'token' | 'resend' | null;
  expediteur: string | null;
  envoyes: number;
  tests: number;
  erreurs: number;
  ignores: number;
  programmes: number;
  planning: { jour: string; count: number }[];
}

/** Levée quand l'API renvoie 401 (jeton manquant/invalide) → affiche le portail. */
export class ErreurAuth extends Error {
  constructor() { super('Authentification requise'); this.name = 'ErreurAuth'; }
}

const CLE_TOKEN = 'apiToken';
export function definirToken(token: string): void { localStorage.setItem(CLE_TOKEN, token.trim()); }

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem(CLE_TOKEN);
  const resp = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (resp.status === 401) throw new ErreurAuth();
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error ?? `Erreur ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  statut: () => req<StatutIntegrations>('/api/statut'),
  biens: (statut?: StatutBien) => req<BienDetecte[]>(`/api/biens${statut ? `?statut=${statut}` : ''}`),
  detail: (ref: string) => req<DetailReponse>(`/api/biens/${encodeURIComponent(ref)}`),
  preview: (ref: string, message: string) =>
    req<{ html: string }>(`/api/biens/${encodeURIComponent(ref)}/preview`, {
      method: 'POST', body: JSON.stringify({ message }),
    }),
  brouillon: (ref: string, sujet: string, message: string) =>
    req<{ ok: true }>(`/api/biens/${encodeURIComponent(ref)}/brouillon`, {
      method: 'POST', body: JSON.stringify({ sujet, message }),
    }),
  setStatut: (ref: string, statut: StatutBien) =>
    req<{ ok: true }>(`/api/biens/${encodeURIComponent(ref)}/statut`, {
      method: 'POST', body: JSON.stringify({ statut }),
    }),
  envoyer: (ref: string, sujet: string, message: string, destinataires: DestinataireEnvoi[]) =>
    req<ResultatEnvoi>(`/api/biens/${encodeURIComponent(ref)}/envoyer`, {
      method: 'POST', body: JSON.stringify({ sujet, message, destinataires }),
    }),
  envois: (ref?: string) => req<Envoi[]>(`/api/envois${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`),
  agentsConnectes: () => req<AgentConnecte[]>('/api/agents-connectes'),
  poll: () => req<{ nouveaux: number; total: number }>('/api/poll', { method: 'POST' }),
};

export function prixFr(prix: number | null): string {
  if (prix == null) return '—';
  return new Intl.NumberFormat('fr-FR').format(prix) + ' €';
}

export function dateFr(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}
