/**
 * Sonde Modelo — comprendre les ÉTATS et les champs de date/diffusion, pour
 * cibler les biens « off-market récents » (pas encore diffusés / sur le marché,
 * avec ou sans photo, créés récemment).
 *
 *   npm run probe:modelo-etats
 */
import { config } from '../config.ts';

async function fetchPage(filters: string, offset = 0): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ relations: 'linked_user_id', limit: '100', offset: String(offset), sort: 'product_ref:asc' });
  if (filters) params.set('filters', filters);
  const r = await fetch(`${config.modelo.baseUrl}/products?${params}`, { headers: { 'x-netty-api-key': config.modelo.apiKey } });
  if (!r.ok) throw new Error(`Modelo ${r.status} ${r.statusText}`);
  const j = (await r.json()) as { data?: Record<string, unknown>[] };
  return j.data ?? [];
}

async function main() {
  // Tous les biens en vente, tous états (paginé).
  const all: Record<string, unknown>[] = [];
  for (let off = 0; ; off += 100) {
    const page = await fetchPage('product_offer_type:equal:1', off);
    all.push(...page);
    if (page.length < 100) break;
  }
  console.log(`Total biens vente (tous états) : ${all.length}\n`);

  // Distribution des états.
  const parEtat: Record<string, number> = {};
  for (const p of all) {
    const k = `${p.state}${p.deleted ? ' (deleted)' : ''}${p.archived ? ' (archived)' : ''}`;
    parEtat[k] = (parEtat[k] ?? 0) + 1;
  }
  console.log('Distribution par state :');
  for (const [k, n] of Object.entries(parEtat).sort()) console.log(`  state ${k} : ${n}`);

  // Champs date / diffusion / online présents.
  const sample = all[0] ?? {};
  const keys = Object.keys(sample);
  const dateKeys = keys.filter((k) => /date|created|updated|online|publi|diffus|mandate|start|created_at/i.test(k));
  console.log(`\nChamps potentiellement utiles (date/diffusion) :\n  ${dateKeys.join(', ') || '(aucun évident)'}`);

  // Pour 3 biens, on imprime ces champs + state + has photo.
  console.log('\nÉchantillon (date/diffusion) :');
  for (const p of all.slice(0, 5)) {
    const vals: Record<string, unknown> = {};
    for (const k of dateKeys) vals[k] = p[k];
    const photos = p.images_public;
    const nbPhotos = Array.isArray(photos) ? photos.length : photos ? '?' : 0;
    console.log(`  ref ${p.product_ref} | state ${p.state} | photos ${nbPhotos} |`, JSON.stringify(vals));
  }

  // Liste complète des clés (pour repérer un champ de création/diffusion non deviné).
  console.log(`\nToutes les clés d'un produit :\n  ${keys.join(', ')}`);
}

main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
