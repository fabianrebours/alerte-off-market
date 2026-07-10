import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import {
  fileDue, marquerFile, getBienDetecte, finaliserLigneFile,
  reserverFile, reclamerFileEnCours, countEnvoisDuJour,
  listDesinscrits, emailDejaContactePourBien, emailContacteDepuis,
} from '../db.ts';
import { resoudreCanal } from './canal.ts';
import { construireEmailHtml, construireEmailTexte, rendreMessage, formatDistance } from './template.ts';
import { estJourOuvreParis, heureParis } from './joursOuvres.ts';

/** Fenêtre d'envoi en mode réel : 9h ≤ heure Paris < 18h. */
const HEURE_DEBUT_ENVOI = 9;
const HEURE_FIN_ENVOI = 18;

/**
 * Traite la file d'attente : envoie les lots dont le jour prévu est arrivé
 * (≈ 30/jour par campagne, posés à l'envoi). Re-vérifie opt-out / cooldown /
 * déjà-contacté au moment réel de l'envoi (l'état a pu changer depuis).
 */
/** Empêche deux drains simultanés (cron 09:00 + rattrapage démarrage + bouton). */
let drainEnCours = false;

export async function traiterFileAttente(): Promise<{ traites: number; envoyes: number; erreurs: number; annules: number }> {
  // Mode réel : jours ouvrés (lun-ven hors fériés français) et fenêtre
  // 9h-18h uniquement — tout est calculé en heure de Paris, le serveur Render
  // tournant en UTC. Les lots en retard restent en file et partent au prochain
  // créneau ouvré, toujours sous le cap journalier. En sandbox on draine
  // n'importe quand (mails de test uniquement).
  const heure = heureParis(new Date());
  if (!config.sandbox) {
    if (!estJourOuvreParis(new Date())) {
      console.log('[file] week-end ou jour férié — aucun envoi aujourd\'hui.');
      return { traites: 0, envoyes: 0, erreurs: 0, annules: 0 };
    }
    if (heure < HEURE_DEBUT_ENVOI || heure >= HEURE_FIN_ENVOI) {
      console.log(`[file] hors fenêtre d'envoi (${HEURE_DEBUT_ENVOI}h-${HEURE_FIN_ENVOI}h Paris) — envoi reporté.`);
      return { traites: 0, envoyes: 0, erreurs: 0, annules: 0 };
    }
  }
  if (drainEnCours) {
    console.log('[file] drain déjà en cours — déclenchement ignoré (anti double-envoi).');
    return { traites: 0, envoyes: 0, erreurs: 0, annules: 0 };
  }
  drainEnCours = true;
  try {
    // Récupère les lignes d'un run précédent interrompu (crash/restart).
    const reclamees = reclamerFileEnCours();
    if (reclamees > 0) console.log(`[file] ${reclamees} ligne(s) « en_cours » orpheline(s) remise(s) en file.`);

    const aujourdhui = new Date().toISOString().slice(0, 10);
    // Cap journalier GLOBAL : on ne dépasse jamais tailleLot envois/jour depuis
    // l'adresse (réputation). On compte ce qui est DÉJÀ parti aujourd'hui
    // (envoi immédiat + file), pas seulement ce run.
    const budget = Math.max(0, config.tailleLot - countEnvoisDuJour(aujourdhui));
    if (budget === 0) {
      console.log(`[file] cap journalier (${config.tailleLot}) déjà atteint — report au prochain jour.`);
      return { traites: 0, envoyes: 0, erreurs: 0, annules: 0 };
    }
    // Étalement sur la journée (réputation de l'adresse) : jamais plus de
    // ~tailleLot/9 envois par créneau horaire (4/h pour 30/jour), même si la
    // campagne est validée en fin de journée — le reliquat glisse aux créneaux
    // et jours ouvrés suivants. En sandbox : tout le budget d'un coup.
    const parHeure = Math.ceil(config.tailleLot / (HEURE_FIN_ENVOI - HEURE_DEBUT_ENVOI));
    const tranche = config.sandbox ? budget : Math.min(budget, parHeure);
    const due = fileDue(aujourdhui).slice(0, tranche);
    if (due.length === 0) return { traites: 0, envoyes: 0, erreurs: 0, annules: 0 };

    const canal = await resoudreCanal(); // expéditeur unique → un seul canal
    if (!canal.envoyer) {
      console.log('[file] aucun canal d\'envoi configuré — drain reporté (rien réservé).');
      return { traites: 0, envoyes: 0, erreurs: 0, annules: 0 };
    }

    const desinscrits = listDesinscrits();
    const depuis = new Date(Date.now() - config.cooldownJours * 86_400_000).toISOString();
    let envoyes = 0, erreurs = 0, annules = 0, traites = 0;

    for (const row of due) {
      // Réservation atomique : si une autre exécution l'a déjà prise, on saute.
      if (!reserverFile(row.id)) continue;
      traites++;
      const email = row.email.toLowerCase();
      // Garde-fous au moment réel de l'envoi (l'état a pu changer depuis l'enqueue).
      if (desinscrits.has(email) || emailDejaContactePourBien(row.product_ref, email) || emailContacteDepuis(email, depuis)) {
        marquerFile(row.id, 'annule'); annules++; continue;
      }
      const detecte = getBienDetecte(row.product_ref);
      if (!detecte) { marquerFile(row.id, 'annule'); annules++; continue; }

      const token = randomUUID();
      const unsubscribeUrl = `${config.appBaseUrl}/desinscription?token=${token}`;
      const messageRendu = rendreMessage(row.message, formatDistance(row.distance_km));
      const html = construireEmailHtml({ bien: detecte.bien, messageAgent: messageRendu, unsubscribeUrl, token });
      const text = construireEmailTexte({ bien: detecte.bien, messageAgent: messageRendu, unsubscribeUrl, token });
      const to = config.sandbox ? config.testRecipient : email;
      const subject = config.sandbox ? `[TEST → ${email}] ${row.sujet}` : row.sujet;
      const base = {
        product_ref: row.product_ref, email, commonhold_id: row.commonhold_id,
        copro_adresse: row.copro_adresse, prenom: row.prenom, nom: row.nom, token,
      };
      try {
        const { messageId } = await canal.envoyer({ to, subject, html, text, unsubscribeUrl });
        // Enregistrement + marquage atomiques : pas d'incohérence si crash entre les deux.
        finaliserLigneFile({ ...base, statut: config.sandbox ? 'test' : 'envoye', message_id: messageId, erreur: null, sent_at: new Date().toISOString() }, row.id, 'envoye');
        envoyes++;
      } catch (e) {
        finaliserLigneFile({ ...base, statut: 'erreur', message_id: null, erreur: (e as Error).message, sent_at: new Date().toISOString() }, row.id, 'erreur');
        erreurs++;
      }
    }

    console.log(`[file] ${envoyes} envoyé(s), ${annules} annulé(s), ${erreurs} erreur(s) sur ${traites} traité(s) — budget jour ${budget}.`);
    return { traites, envoyes, erreurs, annules };
  } finally {
    drainEnCours = false;
  }
}

/**
 * Cron horaire + rattrapage au démarrage. La fenêtre (9h-18h Paris, jours
 * ouvrés) et la tranche horaire sont vérifiées DANS le drain : hors fenêtre,
 * le tick ne fait rien.
 */
export function demarrerCronFileAttente(): void {
  cron.schedule('0 * * * *', () => {
    traiterFileAttente().catch((e) => console.error('[file] échec :', e instanceof Error ? e.message : e));
  });
  setTimeout(() => {
    traiterFileAttente().catch((e) => console.error('[file] échec initial :', e instanceof Error ? e.message : e));
  }, 8000);
  console.log('[file] cron file d\'attente armé (toutes les heures, fenêtre 9h-18h ouvrés + rattrapage démarrage).');
}
