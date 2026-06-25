/**
 * Sonde Omni — découvre comment faire une recherche GÉOGRAPHIQUE des copros
 * (bounding box sur coordinates_latitude/longitude), pour dépasser la limite
 * du seul code postal.
 *
 *   npm run probe:omni-geo
 */
import { runQuery, eqString, pick, type OmniRow } from '../omni/client.ts';
import { config } from '../config.ts';

const BASE_CARE = 'omni_dbt__care_master__commonholds';

// Centre Boulogne-Billancourt (le bien test).
const LAT = 48.836975, LNG = 2.242716;
const R_KM = 1.5;
const dLat = R_KM / 111;
const dLng = R_KM / (111 * Math.cos((LAT * Math.PI) / 180));
const latMin = LAT - dLat, latMax = LAT + dLat;
const lngMin = LNG - dLng, lngMax = LNG + dLng;

const FIELDS = [
  `${BASE_CARE}.commonhold_id`,
  `${BASE_CARE}.address`,
  `${BASE_CARE}.postal_code`,
  `${BASE_CARE}.coordinates_latitude`,
  `${BASE_CARE}.coordinates_longitude`,
];

/** Essaie une forme de filtre numérique et rapporte le résultat. */
async function essaiFiltre(label: string, latFilter: unknown, lngFilter: unknown): Promise<OmniRow[]> {
  try {
    const rows = await runQuery({
      query: {
        modelId: config.omni.modelId,
        table: BASE_CARE,
        fields: FIELDS,
        filters: {
          [`${BASE_CARE}.country`]: eqString(['France']),
          [`${BASE_CARE}.coordinates_latitude`]: latFilter,
          [`${BASE_CARE}.coordinates_longitude`]: lngFilter,
        },
        limit: 200,
      },
      resultType: 'json',
    });
    const cps = new Set(rows.map((r) => pick(r, 'postal_code')).filter(Boolean));
    console.log(`  ✓ ${label} → ${rows.length} copro(s), ${cps.size} CP distinct(s): ${[...cps].slice(0, 8).join(', ')}`);
    return rows;
  } catch (e) {
    console.log(`  ✗ ${label} → ${(e as Error).message.slice(0, 150)}`);
    return [];
  }
}

async function main() {
  console.log(`Box autour de (${LAT}, ${LNG}) ±${R_KM}km :`);
  console.log(`  lat ∈ [${latMin.toFixed(4)}, ${latMax.toFixed(4)}] · lng ∈ [${lngMin.toFixed(4)}, ${lngMax.toFixed(4)}]\n`);

  console.log('→ Essais de filtres numériques bounding box :\n');
  // Variante A : BETWEEN
  await essaiFiltre('BETWEEN',
    { type: 'number', kind: 'BETWEEN', values: [latMin, latMax] },
    { type: 'number', kind: 'BETWEEN', values: [lngMin, lngMax] });
  // Variante B : GREATER_THAN / LESS_THAN (une borne — on testera la combinaison sinon)
  await essaiFiltre('GREATER_THAN_OR_EQUAL_TO (borne basse seule)',
    { type: 'number', kind: 'GREATER_THAN_OR_EQUAL_TO', values: [latMin] },
    { type: 'number', kind: 'GREATER_THAN_OR_EQUAL_TO', values: [lngMin] });
  // Variante C : is (range objet)
  await essaiFiltre('is {gte,lte}',
    { type: 'number', is: { gte: latMin, lte: latMax } },
    { type: 'number', is: { gte: lngMin, lte: lngMax } });
  // Variante D : kind GREATER_THAN + sous-filtre
  await essaiFiltre('GREATER_THAN/LESS_THAN combiné',
    { type: 'number', kind: 'GREATER_THAN', values: [latMin], and: { kind: 'LESS_THAN', values: [latMax] } },
    { type: 'number', kind: 'GREATER_THAN', values: [lngMin], and: { kind: 'LESS_THAN', values: [lngMax] } });

  // Combien de copros Matera AU TOTAL (plan B : tout rapatrier + trier) ?
  console.log('\n→ Volume total de copros Matera (care_master) :\n');
  try {
    const all = await runQuery({
      query: {
        modelId: config.omni.modelId,
        table: BASE_CARE,
        fields: [`${BASE_CARE}.commonhold_id`, `${BASE_CARE}.coordinates_latitude`, `${BASE_CARE}.coordinates_longitude`],
        filters: { [`${BASE_CARE}.country`]: eqString(['France']) },
        limit: 10000,
      },
      resultType: 'json',
    });
    const avecCoords = all.filter((r) => pick(r, 'coordinates_latitude') && pick(r, 'coordinates_longitude'));
    console.log(`  total: ${all.length} · avec coordonnées: ${avecCoords.length}`);
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message.slice(0, 150)}`);
  }
}

main().catch((err) => {
  console.error('✗ Échec sonde :', err instanceof Error ? err.message : err);
  process.exit(1);
});
