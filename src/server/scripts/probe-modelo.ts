/**
 * Sonde Modelo — valide la connexion et la forme des données.
 *   npm run probe:modelo
 */
import { fetchBiensSurLeMarche } from '../modelo/client.ts';

async function main() {
  console.log('→ Récupération des biens « sur le marché » (state=1, vente)…\n');
  const biens = await fetchBiensSurLeMarche();
  const avecPhoto = biens.filter((b) => b.photos.length > 0);
  const avecAdresse = biens.filter((b) => b.adresse && b.codePostal);
  const avecGps = biens.filter((b) => b.latitude != null && b.longitude != null);

  console.log(`Total sur le marché      : ${biens.length}`);
  console.log(`  …avec ≥1 photo         : ${avecPhoto.length}`);
  console.log(`  …avec adresse + CP     : ${avecAdresse.length}`);
  console.log(`  …avec lat/lng          : ${avecGps.length}`);

  const ex = avecPhoto.find((b) => b.adresse) ?? avecPhoto[0] ?? biens[0];
  if (ex) {
    console.log('\n── Exemple de bien normalisé ──');
    console.log(JSON.stringify({ ...ex, photos: ex.photos.slice(0, 2) }, null, 2));
    console.log(`(photos: ${ex.photos.length} au total)`);
  } else {
    console.log('\n⚠ Aucun bien retourné.');
  }
}

main().catch((err) => {
  console.error('✗ Échec sonde Modelo :', err instanceof Error ? err.message : err);
  process.exit(1);
});
