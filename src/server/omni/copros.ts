import { runQuery, eqString, pick, pickNum, haversineKm, type OmniRow } from './client.ts';
import { config } from '../config.ts';

/**
 * Accès Omni dédié à cet outil :
 *  - rechercherCoprosVoisines() : les copros Matera clientes les plus proches
 *    d'un point (calque de dossier-copro/omni.adapter.ts).
 *  - listerCoproprietaires() : tous les copropriétaires (email + nom) d'une
 *    copro, via le join people⋈buildings filtré par commonhold_id.
 *    Lien validé empiriquement (cf. probe-omni-copro).
 */

const BASE_CARE = 'omni_dbt__care_master__commonholds';
const BASE_PEOPLE = 'omni_dbt__product_app__people';
/** Join people → buildings : permet de filtrer les personnes par commonhold_id. */
const JOIN_PEOPLE_BUILDINGS = 'product_app__people___building_id___product_app__buildings';

/** Normalise une adresse pour comparaison tolérante (casse, accents, ponctuation). */
export function normaliserAdresse(s: string | null): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface CoproVoisine {
  commonholdId: string;
  address: string;
  postalCode: string | null;
  city: string | null;
  units: number | null;
  lat: number;
  lng: number;
  distanceKm: number | null;
}

export interface Coproprietaire {
  personId: string | null;
  email: string;
  prenom: string | null;
  nom: string | null;
}

const CHAMPS_COPRO = [
  `${BASE_CARE}.commonhold_id`,
  `${BASE_CARE}.address`,
  `${BASE_CARE}.postal_code`,
  `${BASE_CARE}.city_name`,
  `${BASE_CARE}.units_number`,
  `${BASE_CARE}.coordinates_latitude`,
  `${BASE_CARE}.coordinates_longitude`,
];

/** Filtre numérique Omni « entre deux bornes » (validé : kind=BETWEEN). */
function between(min: number, max: number) {
  return { type: 'number', kind: 'BETWEEN', values: [min, max] };
}

/** Convertit des rows care_master en copros avec distance haversine au centre, triées. */
function mapEtTrie(rows: OmniRow[], lat: number, lng: number): CoproVoisine[] {
  const out: CoproVoisine[] = [];
  for (const row of rows) {
    const id = pick(row, 'commonhold_id');
    const cLat = pickNum(row, 'coordinates_latitude');
    const cLng = pickNum(row, 'coordinates_longitude');
    if (!id || cLat === null || cLng === null) continue;
    out.push({
      commonholdId: id,
      address: pick(row, 'address') ?? '',
      postalCode: pick(row, 'postal_code'),
      city: pick(row, 'city_name'),
      units: pickNum(row, 'units_number'),
      lat: cLat,
      lng: cLng,
      distanceKm: haversineKm(lat, lng, cLat, cLng),
    });
  }
  out.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  return out;
}

/** Requête bounding box (BETWEEN sur lat ET lng) — traverse les codes postaux. */
async function queryBox(lat: number, lng: number, rayonKm: number): Promise<OmniRow[]> {
  const dLat = rayonKm / 111;
  const dLng = rayonKm / (111 * Math.cos((lat * Math.PI) / 180));
  return runQuery({
    query: {
      modelId: config.omni.modelId,
      table: BASE_CARE,
      fields: CHAMPS_COPRO,
      filters: {
        [`${BASE_CARE}.country`]: eqString(['France']),
        [`${BASE_CARE}.coordinates_latitude`]: between(lat - dLat, lat + dLat),
        [`${BASE_CARE}.coordinates_longitude`]: between(lng - dLng, lng + dLng),
      },
      limit: 500,
    },
    resultType: 'json',
  });
}

/** Repli code postal (si le bien n'a pas de coordonnées géocodables). */
async function rechercherParCp(cp: string, country: string, limit: number, center: { lat: number; lng: number } | null): Promise<CoproVoisine[]> {
  const rows = await runQuery({
    query: {
      modelId: config.omni.modelId,
      table: BASE_CARE,
      fields: CHAMPS_COPRO,
      filters: {
        [`${BASE_CARE}.country`]: eqString([country]),
        [`${BASE_CARE}.postal_code`]: eqString([cp]),
      },
      limit: 200,
    },
    resultType: 'json',
  });
  const voisines = center
    ? mapEtTrie(rows, center.lat, center.lng)
    : rows.map((row): CoproVoisine | null => {
        const id = pick(row, 'commonhold_id');
        const lat = pickNum(row, 'coordinates_latitude');
        const lng = pickNum(row, 'coordinates_longitude');
        return id && lat !== null && lng !== null
          ? { commonholdId: id, address: pick(row, 'address') ?? '', postalCode: pick(row, 'postal_code'), city: pick(row, 'city_name'), units: pickNum(row, 'units_number'), lat, lng, distanceKm: null }
          : null;
      }).filter((v): v is CoproVoisine => v !== null);
  return voisines.slice(0, limit);
}

/**
 * Copros Matera les plus proches d'un bien — recherche GÉOGRAPHIQUE (bounding
 * box sur les coordonnées Omni), donc tous codes postaux confondus.
 *
 * Box expansible : on part d'un petit rayon et on l'agrandit jusqu'à obtenir
 * au moins `limit` copros (utile en zone clairsemée). Tri haversine final.
 * Si aucune coordonnée de centre n'est connue, repli sur le code postal.
 */
export async function rechercherCoprosVoisines(input: {
  centerLat?: number | null;
  centerLng?: number | null;
  postalCode?: string | null;
  country?: string;
  limit?: number;
}): Promise<CoproVoisine[]> {
  const limit = input.limit ?? config.nbCoprosVoisines;
  const country = input.country ?? 'France';

  if (input.centerLat != null && input.centerLng != null) {
    const lat = input.centerLat, lng = input.centerLng;
    let rayon = 0.8;        // km — départ serré
    const rayonMax = 12;    // km — élargissement max
    let voisines: CoproVoisine[] = [];
    while (rayon <= rayonMax) {
      voisines = mapEtTrie(await queryBox(lat, lng, rayon), lat, lng);
      if (voisines.length >= limit) break;
      rayon *= 2;
    }
    return voisines.slice(0, limit);
  }

  // Pas de coordonnées → repli code postal.
  if (input.postalCode?.trim()) {
    return rechercherParCp(input.postalCode.trim(), country, limit, null);
  }
  return [];
}

/** Adresses « pro » à exclure du démarchage copropriétaire (anciens syndics, gestion). */
const DOMAINES_PRO_EXCLUS = [
  'montaigne-gestion', 'foncia', 'citya', 'nexity', 'loiselet', 'oralia',
  'sergic', 'immo-de-france', 'square-habitat', 'matera.eu',
];

function estEmailValide(email: string | null): email is string {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  return !DOMAINES_PRO_EXCLUS.some((d) => e.includes(d));
}

/**
 * Tous les copropriétaires (email + nom) d'une copro Matera.
 * Dédup par email, exclusion des adresses pro/syndic, emails invalides écartés.
 */
export async function listerCoproprietaires(commonholdId: string): Promise<Coproprietaire[]> {
  if (!commonholdId.trim()) return [];
  const rows = await runQuery({
    query: {
      modelId: config.omni.modelId,
      table: BASE_PEOPLE,
      fields: [
        `${BASE_PEOPLE}.person_id`,
        `${BASE_PEOPLE}.email`,
        `${BASE_PEOPLE}.first_name`,
        `${BASE_PEOPLE}.last_name`,
        `${JOIN_PEOPLE_BUILDINGS}.commonhold_id`,
      ],
      filters: { [`${JOIN_PEOPLE_BUILDINGS}.commonhold_id`]: eqString([commonholdId]) },
      limit: 500,
    },
    resultType: 'json',
  });

  const parEmail = new Map<string, Coproprietaire>();
  for (const row of rows) {
    const emailBrut = pick(row, 'email');
    if (!estEmailValide(emailBrut)) continue;
    const email = emailBrut.trim().toLowerCase();
    if (parEmail.has(email)) continue;
    parEmail.set(email, {
      personId: pick(row, 'person_id'),
      email,
      prenom: pick(row, 'first_name'),
      nom: pick(row, 'last_name'),
    });
  }
  return Array.from(parEmail.values());
}
