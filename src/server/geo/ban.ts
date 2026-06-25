/**
 * Géocodage BAN (Base Adresse Nationale, api-adresse.data.gouv.fr).
 * Gratuit, sans clé. Repris de server-crm-immo/src/shared/geocoding/ban.service.ts
 * (sans la partie base de données — ici on renvoie juste les coordonnées).
 * Utilisé seulement en repli quand Modelo ne fournit pas de lat/lng.
 */

const BAN_BASE = 'https://api-adresse.data.gouv.fr/search/';

export interface GeocodeResult {
  lat: number;
  lng: number;
}

interface BanResponse {
  features?: { geometry: { coordinates: [number, number] } }[];
}

export async function geocodeAdresse(
  adresse: string,
  codePostal: string,
  ville: string,
): Promise<GeocodeResult | null> {
  const q = `${adresse} ${codePostal} ${ville}`.trim();
  if (!q) return null;
  const url = `${BAN_BASE}?q=${encodeURIComponent(q)}&postcode=${encodeURIComponent(codePostal)}&limit=1`;
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) return null;
    const data = (await resp.json()) as BanResponse;
    const f = data.features?.[0];
    if (!f) return null;
    const [lng, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}
