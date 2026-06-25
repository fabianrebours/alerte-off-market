# Alerte off-market — Matera

Outil interne qui **détecte les biens off-market récents sur Modelo** (non diffusés sur les
portails, avec ou sans photo), trouve les **copropriétés Matera les plus proches** (+ celle du
bien si elle est gérée par Matera), récupère **tous les emails des copropriétaires** (via Omni)
et prépare un **mail simple**. Tous les envois partent d'un **expéditeur unique**
(`transactions@matera.eu`) ; le **nom et le téléphone de l'agent** (récupérés sur Modelo) figurent
en **signature**. L'agent **relit, ajuste et valide** chaque envoi. Lien de désinscription (RGPD) dans chaque mail.

> Standalone, branché sur Modelo/Netty + Omni. Envoi depuis `transactions@matera.eu` (délégation domaine, compte connecté, ou Resend).

## Comment ça marche

```
Modelo (state=1, active_portals vide = off-market, créé ≤ N jours)  ──►  bien détecté (cron 15 min)
        │ adresse + lat/lng
        ▼
Omni care_master  ──►  copros Matera les + proches (bounding box géo, tous CP) + la copro du bien
        │ commonhold_id
        ▼
Omni people⋈buildings  ──►  emails des copropriétaires (dédup, exclus pros/syndic)
        │
        ▼
Brouillon (photo + infos bien + signature agent nom+tél)  ──►  validation  ──►  transactions@matera.eu
                                                                                  │
                                                                  opt-out 1 clic ─┘
```

- **Déclencheur** : un `product_ref` Modelo jamais vu, **off-market** (`active_portals` vide → pas
  diffusé sur SeLoger/LeBonCoin/…), **créé depuis ≤ `RECENCE_JOURS`** (défaut 30) — donc on ignore
  les biens qui datent. Photo facultative.
- **Cibles** : les `NB_COPROS_VOISINES` copros les plus proches ; si l'immeuble du bien est lui-même
  une copro Matera, elle est ajoutée en tête (→ 6).
- **Envoi depuis l'agent** : le mail part de la boîte Gmail Matera de l'agent (refresh token consenti,
  lu dans le CRM). Si l'agent n'a pas connecté Google, repli sur Resend.
- **Anti-spam / RGPD** : exclusion auto des désinscrits, des doublons (un email = la copro la plus
  proche), des déjà-contactés pour ce bien, et **cooldown** (`COOLDOWN_JOURS`, défaut 7) — jamais
  2 mails à la même personne en moins d'une semaine, tous biens confondus. Chaque envoi tracé dans `envois`.
- **Envoi par lots** (`TAILLE_LOT_ENVOI`, défaut 30) : au-delà de 30 destinataires, on envoie 30
  tout de suite et on **programme le reste 30/jour** les jours suivants (ex. 95 → 30 aujourd'hui, 30 J+1,
  30 J+2, 5 J+3). Un cron quotidien (09:00) draine la file ; les garde-fous sont re-vérifiés à l'envoi réel.
- **Bac à sable** (`ENVOI_SANDBOX=1`, défaut) : tous les envois sont redirigés vers `TEST_RECIPIENT`.

## Installation

```bash
npm install
cp .env.example .env   # puis remplir les clés (cf. ci-dessous)
```

Variables `.env` indispensables :
- `MODELO_API_KEY` — clé Netty (même que `server-crm-immo`)
- `OMNI_API_KEY`, `OMNI_MODEL_ID` — accès entrepôt Omni
- `EXPEDITEUR_EMAIL` / `EXPEDITEUR_NOM` — expéditeur unique (défaut `transactions@matera.eu`)
- **Un canal d'envoi** parmi : délégation domaine (`GOOGLE_SA_KEY_FILE`/`_JSON`), compte connecté
  (`GOOGLE_TOKEN_SECRET` + `GOOGLE_CLIENT_ID/SECRET`, l'agent connecte `transactions@matera.eu`), ou `RESEND_API_KEY`
- `RECENCE_JOURS` (défaut 30) · `COOLDOWN_JOURS` (défaut 7) · `TAILLE_LOT_ENVOI` (défaut 30)
- `ENVOI_SANDBOX=0` **uniquement** quand on veut envoyer pour de vrai

## Lancer

```bash
npm run dev        # API (8787) + front Vite (5173) en watch
# ou en prod :
npm run build      # bundle le front dans dist/web
npm start          # sert l'API + le front sur PORT (8787)
```

Ouvrir http://localhost:5173 (dev) ou http://localhost:8787 (prod).

## Sondes (diagnostic des intégrations)

```bash
npm run probe:modelo       # compte les biens sur le marché + photos, dump un exemple
npm run probe:omni-copro   # valide la récupération des emails d'une copro
```

## Architecture

```
src/server/
  config.ts            lecture .env
  db.ts                SQLite (biens_detectes · envois · desinscriptions)
  modelo/              client (retry 502) · types/normalisation · poller cron
  omni/                client · copros (voisines + copropriétaires)
  geo/ban.ts           géocodage de repli (BAN)
  email/               template HTML/texte · provider Resend
  routes/              biens (liste/détail/preview/brouillon/envoi) · optout
  scripts/             sondes
src/web/               React + Vite + Tailwind (liste · composition · journal)
```

## Connexion Google des agents (envoi depuis leur boîte)

Trois canaux possibles, dans l'ordre de priorité à l'envoi :
1. **Délégation domaine (recommandé, zéro clic agent)** — comme tous les agents sont dans l'org
   `matera.eu`, l'admin Workspace autorise une fois un **compte de service** à envoyer comme
   n'importe quel `@matera.eu`. Fournir la clé JSON (`GOOGLE_SA_KEY_FILE` ou `GOOGLE_SA_KEY_JSON`).
2. **Connexion individuelle** — l'agent connecte son Google (onglet **Connexions**), consent au
   scope `gmail.send` ; le refresh token est stocké chiffré (AES-256-GCM) en local (ou réutilisé du CRM).
3. **Resend** — repli si aucun des deux n'est disponible.

### Délégation domaine — config admin (une fois)
1. Compte de service dans Google Cloud + clé JSON.
2. Admin console → **Sécurité → Délégation au niveau du domaine** → ajouter le *client ID* du compte
   de service avec le scope `https://www.googleapis.com/auth/gmail.send`.
3. Renseigner `GOOGLE_SA_KEY_FILE` (ou `..._JSON`) dans `.env`. Fini — aucun agent n'a à se connecter.

### Config Google Cloud (une seule fois)
1. Projet Google Cloud (on peut réutiliser celui du CRM où vivent `GOOGLE_CLIENT_ID/SECRET`).
2. **Écran de consentement OAuth** : type **Interne** (org `matera.eu`) → aucune validation Google
   requise ; ajouter le scope `https://www.googleapis.com/auth/gmail.send`.
3. **ID client OAuth** (type *Application Web*) → **URI de redirection autorisé** :
   `http://localhost:8787/oauth/google/callback` (+ l'URL de prod une fois déployé).
4. Renseigner `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_SECRET` (clé hex 32 octets)
   dans `.env`. ⚠️ Si on réutilise le client OAuth du CRM, il faut y **ajouter l'URI de redirection**
   ci-dessus (sinon `redirect_uri_mismatch`).
5. Chaque agent ouvre **Connexions** et clique « Connecter un compte Google ».

> Alternative sans clic des agents : **délégation domaine** (l'admin Workspace autorise un compte
> de service pour `gmail.send`). Non implémentée ici — me le dire si tu préfères cette voie.

## Recherche géographique des copros

Les 5 copros sont trouvées par **bounding box** sur les coordonnées Omni
(`coordinates_latitude/longitude`, filtre `BETWEEN`), donc **tous codes postaux confondus** :
un bien en limite d'arrondissement/commune ramène les copros voisines même de l'autre côté
de la frontière administrative. La box part d'un rayon serré (0,8 km) et s'élargit
(jusqu'à 12 km) jusqu'à obtenir 5 copros, puis tri haversine. Le centre du bien vient de
Modelo (lat/lng) ou, à défaut, du géocodage BAN de son adresse. Repli code postal si aucune
coordonnée n'est disponible.

## Limites connues (MVP)

- Certaines copros n'ont aucun copropriétaire joignable dans Omni (pas d'utilisateurs app) → 0 contact.
- Les ~0,8 % de copros Matera sans coordonnées dans Omni ne remontent pas dans la box.
- Envoi toujours **validé par l'agent** (pas de mode 100 % automatique).
- DPE/GES dérivés des seuils 2021 à partir des valeurs Modelo (indicatif).
