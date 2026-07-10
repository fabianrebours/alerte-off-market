/**
 * Jours ouvrés français (Europe/Paris) pour la file d'envoi.
 *
 * Le serveur (Render) tourne en UTC : la date civile et le jour de semaine
 * sont donc toujours calculés dans le fuseau Europe/Paris, jamais via
 * getDay()/toISOString() bruts.
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Dimanche de Pâques (algorithme de Meeus/Butcher, calendrier grégorien). */
function paques(annee: number): { mois: number; jour: number } {
  const a = annee % 19;
  const b = Math.floor(annee / 100);
  const c = annee % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31); // 3 = mars, 4 = avril
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return { mois, jour };
}

/** Ensemble des jours fériés légaux français ('YYYY-MM-DD') pour une année. */
export function joursFeriesFrance(annee: number): Set<string> {
  const feries = new Set<string>();
  const ajouter = (mois: number, jour: number) =>
    feries.add(`${annee}-${pad2(mois)}-${pad2(jour)}`);

  // Fériés fixes.
  ajouter(1, 1); // Jour de l'an
  ajouter(5, 1); // Fête du travail
  ajouter(5, 8); // Victoire 1945
  ajouter(7, 14); // Fête nationale
  ajouter(8, 15); // Assomption
  ajouter(11, 1); // Toussaint
  ajouter(11, 11); // Armistice 1918
  ajouter(12, 25); // Noël

  // Fériés mobiles dérivés de Pâques.
  const p = paques(annee);
  const base = new Date(Date.UTC(annee, p.mois - 1, p.jour));
  const ajouterDecale = (jours: number) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + jours);
    feries.add(
      `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    );
  };
  ajouterDecale(1); // Lundi de Pâques
  ajouterDecale(39); // Ascension
  ajouterDecale(50); // Lundi de Pentecôte

  return feries;
}

/** Heure (0-23) de `date` dans le fuseau Europe/Paris. */
export function heureParis(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(date));
}

/** Vrai si `date` tombe un jour ouvré à Paris : lundi-vendredi, hors fériés. */
export function estJourOuvreParis(date: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const annee = Number(get('year'));
  return !joursFeriesFrance(annee).has(`${get('year')}-${get('month')}-${get('day')}`);
}
