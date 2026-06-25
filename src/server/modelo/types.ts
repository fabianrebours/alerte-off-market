/** Produit brut renvoyé par l'API Netty/Modelo (sous-ensemble utile). */
export interface ModeloProduct {
  product_ref?: string | number;
  product_ref_custom?: string | number;
  title?: string;
  product_type?: number;
  product_offer_type?: number;
  address?: string;
  postal_code?: string;
  city?: string;
  surface?: number;
  surface_living_space?: number;
  rooms?: number;
  bedrooms?: number;
  floor?: number;
  price?: number;
  price_seller_net?: number;
  fees?: number;
  latitude?: number;
  longitude?: number;
  coownership?: boolean;
  epc_energy?: number;
  epc_climate?: number;
  epc_date?: string | null;
  details?: string;
  details_listing?: string;
  images_public?: unknown;
  state?: number;
  archived?: boolean;
  deleted?: boolean;
  /** Date de création du bien dans Netty (ISO). */
  time_created?: string;
  /** Portails sur lesquels le bien est actuellement diffusé (vide = off-market). */
  active_portals?: unknown;
  linked_user_id?: ModeloUser | number | null;
}

export interface ModeloUser {
  user_id?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone_mobile?: string;
  job?: string;
}

/** Forme normalisée consommée par le reste de l'app. */
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
  /** Type de mandat (exclusivité) — rempli après coup depuis /mandates. */
  mandatType: 'simple' | 'semi_exclusif' | 'exclusif' | 'delegation' | null;
  /** Date de création Netty (ISO) — sert au filtre de récence. */
  dateCreation: string | null;
  /** true si diffusé sur ≥1 portail (donc plus off-market). */
  diffuse: boolean;
  /** Nombre de portails de diffusion actifs. */
  nbPortails: number;
}

// Modelo product_type → libellé FR (calque de import-biens-modelo.ts).
const TYPE_LABEL: Record<number, string> = {
  1: 'Appartement', 12: 'Appartement', 13: 'Appartement', 14: 'Appartement', 15: 'Appartement', 16: 'Appartement',
  2: 'Maison', 11: 'Maison',
  3: 'Terrain',
  4: 'Parking',
  5: 'Local commercial', 9: 'Local commercial', 17: 'Local commercial', 7: 'Local commercial',
  6: 'Bureau',
  10: 'Immeuble',
  8: 'Autre',
};

/** Seuils DPE 2021 (kWh/m²/an) — classe énergie. */
function classeEnergie(v: number | undefined | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v <= 70) return 'A';
  if (v <= 110) return 'B';
  if (v <= 180) return 'C';
  if (v <= 250) return 'D';
  if (v <= 330) return 'E';
  if (v <= 420) return 'F';
  return 'G';
}

/** Seuils GES 2021 (kgCO₂/m²/an) — classe climat. */
function classeGes(v: number | undefined | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v <= 6) return 'A';
  if (v <= 11) return 'B';
  if (v <= 30) return 'C';
  if (v <= 50) return 'D';
  if (v <= 70) return 'E';
  if (v <= 100) return 'F';
  return 'G';
}

/** DPE final 2021 = la plus mauvaise des deux classes (énergie, GES). */
function dpeFinal(energie: string | null, ges: string | null): string | null {
  if (!energie) return ges;
  if (!ges) return energie;
  return energie >= ges ? energie : ges; // 'G' > 'A' lexicographiquement
}

/**
 * Extrait les URLs de photos depuis images_public (forme Netty variable :
 * tableau d'URLs, ou tableau d'objets {url|src|public_url}, ou objet indexé).
 * Défensif : on ramasse toute string ressemblant à une URL http(s).
 */
export function extrairePhotos(images: unknown): string[] {
  const urls: string[] = [];
  const pushUrl = (s: unknown) => {
    if (typeof s === 'string' && /^https?:\/\//i.test(s)) urls.push(s);
  };
  const walk = (node: unknown) => {
    if (!node) return;
    if (typeof node === 'string') return pushUrl(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(images);
  // Dédup en gardant l'ordre.
  return Array.from(new Set(urls));
}

function pickAgent(u: ModeloProduct['linked_user_id']): { email: string | null; nom: string | null; telephone: string | null } {
  if (!u || typeof u !== 'object') return { email: null, nom: null, telephone: null };
  const email = u.email?.trim() || null;
  const nom = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || null;
  const telephone = u.phone_mobile?.trim() || null;
  return { email, nom, telephone };
}

/** Première valeur non vide (ignore null, undefined et chaîne vide). */
function premierNonVide(...vals: (string | number | undefined | null)[]): string | null {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** Normalise un produit Modelo brut vers BienModelo. */
export function normaliserBien(p: ModeloProduct): BienModelo | null {
  // Clé stable = product_ref (id Netty, toujours présent & unique).
  // product_ref_custom (n° de mandat) est souvent vide → ne convient pas comme PK.
  const ref = premierNonVide(p.product_ref, p.product_ref_custom);
  if (ref == null) return null;
  const energie = classeEnergie(p.epc_energy);
  const ges = classeGes(p.epc_climate);
  const agent = pickAgent(p.linked_user_id);
  const portails = Array.isArray(p.active_portals) ? p.active_portals.length : 0;
  return {
    productRef: String(ref),
    titre: p.title?.trim() || null,
    typeBien: p.product_type != null ? TYPE_LABEL[p.product_type] ?? 'Autre' : null,
    adresse: p.address?.trim() || null,
    codePostal: p.postal_code?.trim() || null,
    ville: p.city?.trim() || null,
    latitude: Number.isFinite(p.latitude) ? (p.latitude as number) : null,
    longitude: Number.isFinite(p.longitude) ? (p.longitude as number) : null,
    surface: Number.isFinite(p.surface_living_space)
      ? (p.surface_living_space as number)
      : Number.isFinite(p.surface) ? (p.surface as number) : null,
    pieces: Number.isFinite(p.rooms) ? (p.rooms as number) : null,
    chambres: Number.isFinite(p.bedrooms) ? (p.bedrooms as number) : null,
    etage: Number.isFinite(p.floor) ? (p.floor as number) : null,
    prix: Number.isFinite(p.price) ? (p.price as number) : null,
    description: premierNonVide(p.details, p.details_listing),
    dpeLettre: dpeFinal(energie, ges),
    gesLettre: ges,
    photos: extrairePhotos(p.images_public),
    agentEmail: agent.email,
    agentNom: agent.nom,
    agentTelephone: agent.telephone,
    state: p.state ?? 0,
    mandatType: null,
    dateCreation: p.time_created ?? null,
    diffuse: portails > 0,
    nbPortails: portails,
  };
}
