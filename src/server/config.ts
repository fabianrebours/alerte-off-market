import 'dotenv/config';

/**
 * Configuration centralisée — lue depuis .env.
 * On valide à la volée (helpers) plutôt qu'avec un schéma lourd : la plupart
 * des clés sont optionnelles au démarrage (l'app affiche un bandeau si manquant)
 * pour pouvoir lancer l'UI même sans toutes les intégrations branchées.
 */

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

/** Lit un nombre depuis l'env avec garde anti-NaN : une faute de frappe (« 30j »)
 *  retombe sur le défaut au lieu de désactiver silencieusement une fonctionnalité. */
function numEnv(name: string, fallback: number): number {
  const v = Number(env(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  port: numEnv('PORT', 8787),
  appBaseUrl: env('APP_BASE_URL', 'http://localhost:8787').replace(/\/$/, ''),

  /** Jeton d'accès à l'API (Bearer). Vide = API ouverte (dev local uniquement). */
  frontApiToken: env('FRONT_API_TOKEN'),

  /** Secret HMAC qui SIGNE les sessions SSO Google. À défaut d'AUTH_SECRET dédié,
   *  on réutilise GOOGLE_TOKEN_SECRET (déjà requis pour le chiffrement). Vide en
   *  dev local → SSO inactif (API ouverte). */
  authSecret: env('AUTH_SECRET') || env('GOOGLE_TOKEN_SECRET') || env('FRONT_API_TOKEN'),

  modelo: {
    apiKey: env('MODELO_API_KEY'),
    baseUrl: env('MODELO_BASE_URL', 'https://webapi.netty.fr/apiv1').replace(/\/$/, ''),
    /** Lire /affairs (type de mandat exclusif/simple). Même clé que /products.
     *  Best-effort : si l'appel échoue, mandatType reste null. */
    affairs: env('MODELO_AFFAIRS', '1') === '1',
  },

  omni: {
    apiKey: env('OMNI_API_KEY'),
    // Le code historique attend OMNI_URL ; on retombe sur OMNI_INSTANCE_URL.
    url: (env('OMNI_URL') || env('OMNI_INSTANCE_URL', 'https://matera.omniapp.co')).replace(/\/$/, ''),
    modelId: env('OMNI_MODEL_ID'),
  },

  /**
   * Expéditeur AFFICHÉ (From) de tous les mails — l'identité de l'agent va en signature.
   * `email` doit être une adresse que le compte d'envoi est autorisé à utiliser
   * (alias « Envoyer en tant que » de Gmail).
   */
  expediteur: {
    nom: env('EXPEDITEUR_NOM', 'Matera Transaction'),
    email: env('EXPEDITEUR_EMAIL', 'transactions@matera.eu'),
  },

  /**
   * Compte Google qui s'AUTHENTIFIE pour envoyer (porteur du token), ex.
   * fabian.rebours@matera.eu. Vide = on prend le 1er compte connecté dans l'app.
   */
  compteEnvoi: env('COMPTE_ENVOI_EMAIL'),

  resend: {
    apiKey: env('RESEND_API_KEY'),
    from: env('RESEND_FROM_EMAIL', 'Matera Transaction <transactions@matera.eu>'),
  },

  /** Base CRM partagée — lecture seule des refresh tokens Google des agents. */
  crmDatabaseUrl: env('CRM_DATABASE_URL'),

  /** OAuth Google — pour envoyer depuis la boîte Gmail de l'agent. */
  google: {
    tokenSecret: env('GOOGLE_TOKEN_SECRET'),
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    /** Délégation domaine : clé JSON du compte de service (chemin OU JSON inline). */
    serviceAccountFile: env('GOOGLE_SA_KEY_FILE'),
    serviceAccountJson: env('GOOGLE_SA_KEY_JSON'),
  },

  /** Mode bac à sable : redirige TOUS les envois vers testRecipient. */
  sandbox: env('ENVOI_SANDBOX', '1') === '1',
  testRecipient: env('TEST_RECIPIENT', 'fabian.rebours@matera.eu'),

  /** Base des landing pages par bien (Scaleway). URL finale : {base}/modelo-{product_ref}.html */
  lpBaseUrl: env('LP_BASE_URL', 'https://s3.fr-par.scw.cloud/crm-immo-prod/lp').replace(/\/$/, ''),

  /** Nombre de copropriétés voisines à cibler (+ la copro du bien si Matera). */
  nbCoprosVoisines: numEnv('NB_COPROS_VOISINES', 5),

  /** Fenêtre de récence : on ne considère que les biens créés depuis ≤ N jours. */
  recenceJours: numEnv('RECENCE_JOURS', 30),

  /** Cooldown anti-spam : pas 2 mails à la même personne en moins de N jours. */
  cooldownJours: numEnv('COOLDOWN_JOURS', 7),

  /** Taille d'un lot d'envoi quotidien (au-delà, étalé sur les jours suivants). */
  tailleLot: numEnv('TAILLE_LOT_ENVOI', 30),
} as const;

/** Petites vérifs lisibles pour l'UI / les logs de démarrage. */
export function statutIntegrations() {
  return {
    modelo: Boolean(config.modelo.apiKey),
    omni: Boolean(config.omni.apiKey && config.omni.modelId),
    resend: Boolean(config.resend.apiKey),
    gmailAgent: Boolean(
      config.crmDatabaseUrl && config.google.tokenSecret && config.google.clientId && config.google.clientSecret,
    ),
    sandbox: config.sandbox,
  };
}
