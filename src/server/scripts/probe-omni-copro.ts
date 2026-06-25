/**
 * Sonde Omni — explorateur de schéma pour la brique « emails d'une copro ».
 * Omni renvoie des clés en libellés ("Building ID", "Email"). On cherche
 * comment relier une copro (commonhold) à ses personnes (qui portent l'email).
 *
 *   npm run probe:omni-copro
 */
import { runQuery, eqString, pick, type OmniRow } from '../omni/client.ts';
import { config } from '../config.ts';

const BASE_CARE = 'omni_dbt__care_master__commonholds';
const BASE_PEOPLE = 'omni_dbt__product_app__people';
const BASE_BUILDINGS = 'omni_dbt__product_app__buildings';

// CP connus avec des copros Matera (découplé de Modelo, qui renvoie des 502).
const CPS_TEST = ['92100', '75011', '75018', '92300', '75015', '75017', '94300'];

/** Exécute une requête et rapporte (lignes, clés de la 1ʳᵉ row) ou l'erreur. */
async function essai(label: string, body: unknown): Promise<OmniRow[]> {
  try {
    const rows = await runQuery(body);
    const keys = rows[0] ? Object.keys(rows[0]).join(' | ') : '(aucune ligne)';
    console.log(`  ✓ ${label} → ${rows.length} ligne(s)`);
    console.log(`     clés: ${keys}`);
    return rows;
  } catch (e) {
    console.log(`  ✗ ${label} → ${(e as Error).message.slice(0, 150)}`);
    return [];
  }
}

async function main() {
  // 1) Copro Matera dans un CP de test -----------------------------------
  console.log('→ 1) Copro Matera dans un CP de test\n');
  let copros: OmniRow[] = [];
  let cpTrouve = '';
  for (const cp of CPS_TEST) {
    const rows = await runQuery({
      query: {
        modelId: config.omni.modelId,
        table: BASE_CARE,
        fields: [
          `${BASE_CARE}.commonhold_id`,
          `${BASE_CARE}.address`,
          `${BASE_CARE}.postal_code`,
          `${BASE_CARE}.city_name`,
          `${BASE_CARE}.units_number`,
        ],
        filters: { [`${BASE_CARE}.postal_code`]: eqString([cp]) },
        limit: 50,
      },
      resultType: 'json',
    }).catch(() => [] as OmniRow[]);
    if (rows.length) { copros = rows; cpTrouve = cp; break; }
  }
  if (!copros.length) { console.log('⚠ aucune copro Matera trouvée'); return; }

  copros.sort((a, b) => (Number(pick(b, 'units_number')) || 0) - (Number(pick(a, 'units_number')) || 0));
  const copro = copros[0];
  const commonholdId = pick(copro, 'commonhold_id') ?? '';
  console.log(`  ✓ CP ${cpTrouve} : ${copros.length} copro(s)`);
  console.log(`     clés care_master: ${Object.keys(copro).join(' | ')}`);
  console.log(`  copro test → commonhold_id=${commonholdId} | ${pick(copro, 'address')} | ${pick(copro, 'units_number')} lots\n`);

  // 2) Vue buildings : commonhold_id → building_id ------------------------
  console.log('→ 2) Vue buildings (commonhold_id → building_id)\n');
  const buildings = await essai('buildings filtré par commonhold_id', {
    query: {
      modelId: config.omni.modelId,
      table: BASE_BUILDINGS,
      fields: [`${BASE_BUILDINGS}.building_id`, `${BASE_BUILDINGS}.commonhold_id`, `${BASE_BUILDINGS}.address`],
      filters: { [`${BASE_BUILDINGS}.commonhold_id`]: eqString([commonholdId]) },
      limit: 10,
    },
    resultType: 'json',
  });
  const buildingIds = buildings.map((r) => pick(r, 'building_id')).filter(Boolean) as string[];
  console.log(`     building_id(s): ${buildingIds.join(', ') || '∅'}\n`);

  // 3) people filtré par chaque building_id réel --------------------------
  console.log('→ 3) people filtré par Building ID réel → emails\n');
  for (const bid of buildingIds.slice(0, 2)) {
    const rows = await essai(`people building_id=${bid}`, {
      query: {
        modelId: config.omni.modelId,
        table: BASE_PEOPLE,
        fields: [`${BASE_PEOPLE}.person_id`, `${BASE_PEOPLE}.email`, `${BASE_PEOPLE}.building_id`],
        filters: { [`${BASE_PEOPLE}.building_id`]: eqString([bid]) },
        limit: 100,
      },
      resultType: 'json',
    });
    const emails = Array.from(new Set(rows.map((r) => pick(r, 'email')).filter(Boolean))) as string[];
    console.log(`     ${emails.length} email(s) uniques. Ex: ${emails.slice(0, 4).join(', ')}\n`);
  }

  // 4) Plan B (RETENU) : join people → buildings, filtre par commonhold_id
  console.log('→ 4) Plan B (retenu) : join people⋈buildings filtré commonhold_id\n');
  const JOIN = 'product_app__people___building_id___product_app__buildings';
  const rows = await essai('people via join buildings.commonhold_id', {
    query: {
      modelId: config.omni.modelId,
      table: BASE_PEOPLE,
      fields: [
        `${BASE_PEOPLE}.person_id`,
        `${BASE_PEOPLE}.email`,
        `${BASE_PEOPLE}.first_name`,
        `${BASE_PEOPLE}.last_name`,
        `${JOIN}.commonhold_id`,
      ],
      filters: { [`${JOIN}.commonhold_id`]: eqString([commonholdId]) },
      limit: 200,
    },
    resultType: 'json',
  });
  const emails = Array.from(new Set(
    rows.map((r) => pick(r, 'email')).filter((e): e is string => !!e && e.includes('@')),
  ));
  console.log(`     → ${emails.length} email(s) uniques valides sur ${rows.length} personnes`);
  console.log(`     ex: ${emails.slice(0, 5).join(', ')}`);
}

main().catch((err) => {
  console.error('✗ Échec sonde Omni :', err instanceof Error ? err.message : err);
  process.exit(1);
});
