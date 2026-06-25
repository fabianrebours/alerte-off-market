import { config } from '../config.ts';
import { resoudreCompteEnvoi } from '../agents/crm.ts';
import { delegationDisponible, envoyerViaGmailDelegation } from './gmailDelegation.ts';
import { envoyerViaGmailAgent } from './gmail.ts';
import { envoyerViaResend } from './provider.ts';

export interface MessageEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** URL d'opt-out (token unique par envoi) → en-tête List-Unsubscribe + pied de page. */
  unsubscribeUrl: string;
}

export interface Canal {
  canal: 'gmail' | 'resend' | 'aucun';
  /** 'delegation' | 'token' | 'resend' | null — d'où vient le droit d'envoi (canal PRIMAIRE). */
  source: 'delegation' | 'token' | 'resend' | null;
  expediteur: string | null;
  envoyer?: (msg: MessageEmail) => Promise<{ messageId: string }>;
}

interface Candidat {
  canal: 'gmail' | 'resend';
  source: 'delegation' | 'token' | 'resend';
  expediteur: string;
  envoyer: (msg: MessageEmail) => Promise<{ messageId: string }>;
}

/**
 * Canal d'envoi — TOUS les mails partent d'un expéditeur UNIQUE
 * (`config.expediteur`, ex. transactions@matera.eu). L'identité de l'agent
 * (nom + téléphone) est portée par la signature dans le corps, pas par le From.
 *
 * Ordre : 1) délégation domaine (impersonation de l'expéditeur),
 *         2) token OAuth d'un compte connecté qui envoie AVEC l'alias From,
 *         3) Resend (from = expéditeur).
 *
 * Repli au RUNTIME : `envoyer` essaie les canaux disponibles dans l'ordre et
 * bascule sur le suivant si l'un échoue (ex. clé de délégation présente mais
 * non habilitée). Le canal « affiché » reste le primaire.
 */
export async function resoudreCanal(): Promise<Canal> {
  const exp = config.expediteur;
  const candidats: Candidat[] = [];

  if (delegationDisponible()) {
    candidats.push({
      canal: 'gmail', source: 'delegation', expediteur: exp.email,
      envoyer: (m) => envoyerViaGmailDelegation({ email: exp.email, nom: exp.nom }, m),
    });
  }
  // Token d'un compte connecté (ex. fabian.rebours@matera.eu) ; le From affiché
  // reste l'alias expéditeur (transactions@matera.eu), vérifié « Envoyer en tant que ».
  const compte = await resoudreCompteEnvoi();
  if (compte) {
    candidats.push({
      canal: 'gmail', source: 'token', expediteur: exp.email,
      envoyer: (m) => envoyerViaGmailAgent({ nom: exp.nom, email: exp.email, refreshToken: compte.refreshToken }, m),
    });
  }
  if (config.resend.apiKey) {
    candidats.push({
      canal: 'resend', source: 'resend', expediteur: config.resend.from,
      envoyer: (m) => envoyerViaResend({ to: m.to, subject: m.subject, html: m.html, text: m.text, unsubscribeUrl: m.unsubscribeUrl }),
    });
  }

  if (candidats.length === 0) return { canal: 'aucun', source: null, expediteur: null };

  const primaire = candidats[0];
  return {
    canal: primaire.canal,
    source: primaire.source,
    expediteur: primaire.expediteur,
    envoyer: async (m) => {
      let derniere: Error | null = null;
      for (const c of candidats) {
        try {
          return await c.envoyer(m);
        } catch (e) {
          derniere = e as Error;
          console.warn(`[canal] échec ${c.source} : ${derniere.message} — bascule sur le canal suivant.`);
        }
      }
      throw derniere ?? new Error('Aucun canal n\'a pu envoyer');
    },
  };
}
