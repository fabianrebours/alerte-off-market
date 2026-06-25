import { config } from '../config.ts';

/**
 * Client Omni minimal — POST /api/v1/query/run.
 * Repris de server-crm-immo/src/modules/dossier-copro/adapters/omni.adapter.ts.
 */

export interface OmniRow {
  [fqn: string]: unknown;
}

interface OmniResp {
  result?: OmniRow[];
  rows?: OmniRow[];
}

/** Filtre Omni EQUALS typé string. */
export function eqString(values: string[]) {
  return { type: 'string', kind: 'EQUALS', values };
}

/**
 * Forme canonique d'une clé : minuscules, sans caractère non alphanumérique.
 * Permet de matcher indifféremment "Commonhold ID", "commonhold_id" et
 * "omni_dbt__care_master__commonholds.commonhold_id" → "commonholdid".
 */
function canon(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Lit une valeur dans une row Omni avec fallback tolérant. Omni renvoie les
 * colonnes en libellés humains ("Person ID", "Building ID"), pas en FQN —
 * on canonicalise pour matcher quelle que soit la casse/séparateur.
 */
export function pick(row: OmniRow, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  const entries = Object.entries(row);
  for (const target of keys.map(canon)) {
    for (const [orig, v] of entries) {
      const c = canon(orig);
      if ((c === target || c.endsWith(target)) && v !== undefined && v !== null && v !== '') {
        return String(v);
      }
    }
  }
  return null;
}

export function pickNum(row: OmniRow, ...keys: string[]): number | null {
  const v = pick(row, ...keys);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function runQuery(body: unknown, timeoutMs = 15000): Promise<OmniRow[]> {
  if (!config.omni.apiKey) throw new Error('OMNI_API_KEY non configuré');
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${config.omni.url}/api/v1/query/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.omni.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Omni ${r.status}: ${txt.slice(0, 400)}`);
    }
    const data = (await r.json()) as OmniResp | OmniRow[];
    if (Array.isArray(data)) return data;
    return data.result ?? data.rows ?? [];
  } finally {
    clearTimeout(tid);
  }
}

/** Distance haversine en kilomètres entre deux points GPS. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
