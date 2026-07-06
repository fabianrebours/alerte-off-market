import { config } from '../config.ts';
import { normaliserBien, type BienModelo, type ModeloProduct } from './types.ts';

const BATCH_SIZE = 100;
const TIMEOUT_MS = 15_000; // garde-fou : un socket pendu sous throttle ne fige plus le poll
const PAUSE_PAGE_MS = 350; // throttle de pagination : on n'enchaîne plus les pages en rafale
const THROTTLE_DEFAUT_MS = 15 * 60_000; // cooldown si Netty ne renvoie pas de Retry-After

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Erreur de throttle/quota Netty : on NE retente PAS et on ouvre le
 * circuit-breaker pour ne plus marteler la clé (cf. `throttledUntil`).
 */
export class ModeloThrottleError extends Error {
  constructor(message: string, readonly until: number) {
    super(message);
    this.name = 'ModeloThrottleError';
  }
}

/**
 * Circuit-breaker : tant que `Date.now() < throttledUntil`, tout appel Modelo
 * est court-circuité (on ne touche plus la clé throttlée). Armé sur 401/403/429,
 * réinitialisable par un poll manuel (humain qui veut forcer un essai).
 */
let throttledUntil = 0;

export function reinitialiserThrottleModelo(): void {
  throttledUntil = 0;
}

function minutesRestantes(): number {
  return Math.max(1, Math.ceil((throttledUntil - Date.now()) / 60_000));
}

function armerThrottle(retryAfterSec?: number): void {
  const cooldownMs = retryAfterSec && Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? retryAfterSec * 1000
    : THROTTLE_DEFAUT_MS;
  // On ne raccourcit jamais un cooldown déjà posé.
  throttledUntil = Math.max(throttledUntil, Date.now() + cooldownMs);
}

/**
 * GET Modelo robuste :
 *  - circuit-breaker : si la clé est déjà throttlée, on échoue tout de suite
 *    SANS toucher l'API ;
 *  - timeout dur (AbortController) — un socket pendu ne fige plus le poll ;
 *  - on ne RETENTE que les erreurs transitoires (5xx, réseau, timeout) ;
 *  - 401/403/429 = quota/clé → on ARME le breaker et on s'arrête (plus de
 *    rafale qui aggrave le throttle).
 */
async function modeloGet(path: string, tentatives = 4): Promise<Response> {
  if (Date.now() < throttledUntil) {
    throw new ModeloThrottleError(
      `Clé Netty throttlée (quota/limite) — réessaie dans ~${minutesRestantes()} min, ou clique « Rafraîchir Modelo » pour forcer un essai.`,
      throttledUntil,
    );
  }
  let derniere: Error | null = null;
  for (let i = 0; i < tentatives; i++) {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${config.modelo.baseUrl}${path}`, {
        headers: { 'x-netty-api-key': config.modelo.apiKey },
        signal: ctrl.signal,
      });
    } catch (e) {
      // Réseau ou timeout (AbortError) → transitoire, on retente.
      derniere = (e as Error).name === 'AbortError'
        ? new Error(`Modelo API timeout (>${TIMEOUT_MS / 1000}s) sur ${path}`)
        : (e as Error);
      clearTimeout(minuteur);
      await sleep(500 * 2 ** i); // 0.5s, 1s, 2s, 4s
      continue;
    }
    clearTimeout(minuteur);

    if (resp.ok) return resp;

    // Quota / clé throttlée → on arme le breaker et on n'insiste pas.
    if (resp.status === 401 || resp.status === 403 || resp.status === 429) {
      const ra = Number(resp.headers.get('retry-after'));
      armerThrottle(Number.isFinite(ra) ? ra : undefined);
      throw new ModeloThrottleError(
        `Modelo API ${resp.status} (quota/clé épuisé·e) — pause ~${minutesRestantes()} min avant nouvel essai.`,
        throttledUntil,
      );
    }
    // Autre 4xx → définitif, inutile de retenter.
    if (resp.status < 500) {
      throw new Error(`Modelo API ${resp.status} ${resp.statusText}`);
    }
    // 5xx → transitoire, on retente avec backoff.
    derniere = new Error(`Modelo API ${resp.status} ${resp.statusText}`);
    await sleep(500 * 2 ** i);
  }
  throw derniere ?? new Error('Modelo API : échec inconnu');
}

/**
 * Récupère les biens d'un état Modelo donné (paginé), pour la vente
 * (product_offer_type=1). Calque de import-biens-modelo.ts.
 */
async function fetchEtat(state: number): Promise<ModeloProduct[]> {
  if (!config.modelo.apiKey) throw new Error('MODELO_API_KEY non configuré');
  const out: ModeloProduct[] = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      relations: 'linked_user_id',
      limit: String(BATCH_SIZE),
      offset: String(offset),
      sort: 'product_ref:asc',
      filters: `product_offer_type:equal:1,state:equal:${state}`,
    });
    const resp = await modeloGet(`/products?${params.toString()}`);
    const json = (await resp.json()) as { data?: ModeloProduct[] };
    const batch = json.data ?? [];
    out.push(...batch);
    if (batch.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
    await sleep(PAUSE_PAGE_MS); // espace les pages pour ne pas marteler la clé
  }
  return out;
}

/**
 * Biens actuellement « sur le marché » (state=1), vivants (non supprimés /
 * archivés), normalisés. C'est la source du déclencheur.
 */
export async function fetchBiensSurLeMarche(): Promise<BienModelo[]> {
  const bruts = (await fetchEtat(1)).filter((p) => !p.deleted && !p.archived);
  return bruts
    .map(normaliserBien)
    .filter((b): b is BienModelo => b !== null);
}

/**
 * Récupère UN bien Modelo par sa référence (normalisation identique au poll).
 * Sert à inclure manuellement un bien qui échappe au détecteur off-market
 * (déjà diffusé, ou trop ancien). Renvoie null si introuvable/supprimé.
 */
export async function fetchBienParRef(ref: string): Promise<BienModelo | null> {
  if (!config.modelo.apiKey) throw new Error('MODELO_API_KEY non configuré');
  const params = new URLSearchParams({
    relations: 'linked_user_id',
    filters: `product_ref:equal:${ref}`,
    limit: '1',
  });
  const resp = await modeloGet(`/products?${params.toString()}`);
  const json = (await resp.json()) as { data?: ModeloProduct[] };
  const brut = json.data?.[0];
  if (!brut || brut.deleted || brut.archived) return null;
  return normaliserBien(brut);
}

export type MandatType = 'simple' | 'semi_exclusif' | 'exclusif' | 'delegation';

/**
 * Enum officiel Netty `mandates.exclusivity` :
 *   1=Exclusif, 2=Co-exclusif, 3=Semi-exclusif, 4=Délégation, 5=Simple.
 * ⚠ L'ancienne implémentation INVERSAIT 1 et 5 (1→simple, 5→exclusif) : faux.
 * Co-exclusif (2) = exclusivité partagée → traité comme semi-exclusif.
 * Délégation (4) = type à part, non fondu dans les autres.
 */
function mapExclusivite(excl: number | undefined): MandatType {
  switch (excl) {
    case 1: return 'exclusif';
    case 2: return 'semi_exclusif'; // co-exclusif
    case 3: return 'semi_exclusif';
    case 4: return 'delegation';
    case 5: return 'simple';
    default: return 'simple';
  }
}

interface NettyMandateLite {
  deleted?: boolean;
  mandate_type?: number; // 1 = vente, 3 = autre
  exclusivity?: number; // 1=simple, 3=semi_exclusif, 5=exclusif
  linked_product_ref?: { product_ref?: string | number } | null;
}

/**
 * Map product_ref → type de mandat, via /mandates (champ `exclusivity` direct).
 *
 * On lit /mandates (≈ une centaine de mandats actifs en prod, 1-2 pages) et NON
 * /affairs : /affairs contient des milliers d'entrées, donc le cap de pages y
 * ratait les mandats un peu anciens (symptôme : « tout remonte sauf le mandat »).
 * Même approche que l'import legacy `import-mandats-modelo.ts`.
 *
 * Un mandat de vente (`mandate_type === 1`) prime ; à défaut on garde un mandat
 * quelconque du bien en repli. On s'arrête dès que tous les `refsVoulus` sont
 * couverts, ou après `maxPages` pages.
 */
export async function fetchExclusivitesParProduit(
  refsVoulus?: Set<string>,
  maxPages = 30,
): Promise<Map<string, MandatType>> {
  const map = new Map<string, MandatType>();
  const venteTrouvee = new Set<string>(); // refs dont on a déjà le mandat de vente
  if (!config.modelo.apiKey) return map;
  const tousTrouves = () =>
    refsVoulus !== undefined && refsVoulus.size > 0 && [...refsVoulus].every((r) => venteTrouvee.has(r));

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      relations: 'linked_product_ref',
      filters: 'deleted:equal:0',
      limit: String(BATCH_SIZE),
      offset: String(page * BATCH_SIZE),
      sort: 'mandate_id:asc',
    });
    const resp = await modeloGet(`/mandates?${params.toString()}`);
    const json = (await resp.json()) as { data?: NettyMandateLite[] };
    const batch = json.data ?? [];
    for (const m of batch) {
      if (m.deleted) continue;
      const ref = m.linked_product_ref?.product_ref;
      if (ref == null) continue;
      const key = String(ref);
      if (m.mandate_type === 1) {
        map.set(key, mapExclusivite(m.exclusivity)); // mandat de vente : fait foi
        venteTrouvee.add(key);
      } else if (!map.has(key)) {
        map.set(key, mapExclusivite(m.exclusivity)); // repli si aucun mandat de vente
      }
    }
    if (batch.length < BATCH_SIZE || tousTrouves()) break;
    await sleep(PAUSE_PAGE_MS); // espace les pages (Netty throttle vite)
  }
  return map;
}

/**
 * Cible du déclencheur : biens **off-market** (non diffusés sur les portails)
 * et **récents** (créés depuis ≤ recenceJours). Photo facultative.
 * — off-market = `active_portals` vide (cf. probe-modelo-etats).
 * — récence = `time_created` dans la fenêtre (exclut les biens qui « datent »).
 */
export async function fetchBiensOffMarketRecents(): Promise<BienModelo[]> {
  const limite = Date.now() - config.recenceJours * 86_400_000;
  return (await fetchBiensSurLeMarche()).filter((b) => {
    if (b.diffuse) return false; // déjà diffusé → plus off-market
    if (!b.dateCreation) return false;
    const t = new Date(b.dateCreation).getTime();
    return Number.isFinite(t) && t >= limite;
  });
}
