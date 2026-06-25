# Audit poussé — Alerte off-market

_Réalisé le 2026-06-25. Périmètre : tout `src/` (~3 400 lignes). Mention « ✅ vérifié » = fichier relu directement pendant l'audit ; « 🔎 audit approfondi » = remonté par l'analyse spécialisée avec `fichier:ligne` à confirmer en relecture._

## Résumé exécutif

L'outil est **fonctionnellement abouti** et plusieurs fondations sont saines (chiffrement des tokens, SQL paramétré, restriction de domaine, opt-out présent dans chaque mail). Mais quatre familles de risques **bloquent une mise en production réelle** (`ENVOI_SANDBOX=0`) :

1. **Aucune authentification** sur l'API → exfiltration de données perso + capacité d'envoi de cold-mails ouverte à quiconque atteint le serveur.
2. **Le blocage Netty (401) est auto-infligé** par le client Modelo (pas de gestion 401/429, pas de timeout, pagination en rafale). C'est exactement « reprendre où on en était ».
3. **Double-envoi d'emails** possible (écriture non atomique + 3 déclencheurs concurrents + rattrapage qui ignore le cap 30/jour).
4. **Conformité cold-email 2026 incomplète** : `List-Unsubscribe` one-click absent, opt-out en GET only.

## Statut de remédiation (2026-06-25)

Le plan en 6 étapes ci-dessous a été **entièrement implémenté et vérifié** : `tsc` 0 erreur, build front OK, boot serveur sain, auth `401` sans jeton / `200` avec, et MIME décodé (List-Unsubscribe + base64 + RFC 2047 + round-trip accents).

| # | Finding | Statut |
|---|---------|--------|
| 1 | Auth `/api` | ✅ middleware Bearer (`FRONT_API_TOKEN`, temps constant) + portail UI |
| 2 | 401 Netty auto-infligé | ✅ circuit-breaker + `Retry-After` + timeout + pause pagination |
| 3 | Double-envoi | ✅ réservation atomique + garde de réentrance + finalisation transactionnelle + verrou anti double-clic |
| 4 | Rattrapage boot sans cap | ✅ cap journalier global au drain + reclaim des `en_cours` |
| 5 | List-Unsubscribe / opt-out GET | ✅ en-têtes one-click RFC 8058 (Gmail + Resend) + route POST |
| 6 | Opt-out prefetch/CSRF | ✅ GET = confirmation, POST = action |
| 7 | XSS pages OAuth | ✅ échappement HTML (email + message d'erreur) |
| 9 | Encodage `7bit` mensonger | ✅ base64 + multipart/alternative (texte + html) |
| 10 | `NaN` config silencieux | ✅ `numEnv` avec garde |
| 11 | Erreurs Omni avalées | ✅ propagation → 502 visible |
| 12 | Pas de repli de canal | ✅ chaîne de repli au runtime (délégation→token→Resend) |
| 13 | DB world-readable | ✅ `chmod 600` au démarrage |
| 14 | Secrets `.env` | ⚙️ `FRONT_API_TOKEN` câblé + documenté ; rotation/segrégation = opérationnel (hors code) |
| 16 | `From` non RFC 2047 | ✅ encodé |
| 17 | helmet/CSP + process | ✅ 4 en-têtes sécurité + handlers `unhandledRejection`/`uncaughtException` |

**Hors plan (assumé)** : **#8** (statut `envoye` figé) — laissé tel quel : impact pratique faible car l'UI dérive la progression des compteurs réels (`nbEnvoyes`/`nbEnAttente`), pas du statut ; **#15** (bounding box près des pôles) — FAIBLE, métropole non concernée.

## Tableau priorisé

| # | Sév. | Fichier:ligne | Sujet | Statut |
|---|------|---------------|-------|--------|
| 1 | 🔴 CRITIQUE | `index.ts:23-25` | Aucune auth sur `/api` (envois, données perso, file) | ✅ vérifié |
| 2 | 🔴 CRITIQUE | `modelo/client.ts:12-31,41-55,105-123` | 401/429 jetés sans `Retry-After`, pas de timeout, rafale de pagination → throttle Netty | ✅ vérifié |
| 3 | 🔴 CRITIQUE | `email/fileAttente.ts:48-56` | Envoi réseau + marquage non atomiques, pas de garde de réentrance, 3 déclencheurs concurrents → double-envoi | ✅ vérifié |
| 4 | 🔴 CRITIQUE | `email/fileAttente.ts:67` + `db.ts (fileDue)` | Rattrapage au boot draine tout l'arriéré, cap 30/j seulement à l'enqueue | ✅ vérifié |
| 5 | 🟠 ÉLEVÉ | `email/gmailRaw.ts`, `provider.ts`, `optout.ts:20` | `List-Unsubscribe`/`-Post` absents **et** opt-out en GET → one-click RFC 8058 = 404 | ✅ vérifié |
| 6 | 🟠 ÉLEVÉ | `routes/optout.ts:20-39` | Désinscription en GET sans confirmation (CSRF/prefetch), définitive (`INSERT OR IGNORE`), pas de réinscription | ✅ vérifié |
| 7 | 🟠 ÉLEVÉ | `routes/oauth.ts:25,88,100` | État CSRF en mémoire non lié à session ; message d'erreur reflété non échappé (XSS) | ✅ vérifié |
| 8 | 🟠 ÉLEVÉ | `routes/biens.ts:301` | Bien marqué `envoye` même si tous les envois programmés échouent ensuite | 🔎 audit approfondi |
| 9 | 🟡 MOYEN | `email/gmailRaw.ts:10` | Corps UTF-8 déclaré `Content-Transfer-Encoding: 7bit` → mojibake accents / signal spam | ✅ vérifié |
| 10 | 🟡 MOYEN | `config.ts:75-84` | `Number(env())` sans garde `NaN` → une faute de frappe désactive la détection en silence | ✅ vérifié |
| 11 | 🟡 MOYEN | `omni/copros.ts:101,118,204` | `.catch(() => [])` : panne Omni indistinguable d'un vrai « 0 copropriété » | 🔎 audit approfondi |
| 12 | 🟡 MOYEN | `email/canal.ts:34-39` | Canal délégation choisi sur simple présence de la clé ; échec runtime = 100 % d'erreurs, pas de repli Resend | ✅ vérifié |
| 13 | 🟡 MOYEN | `db.ts` + `data/app.db` | Données perso (emails/noms) en clair, fichier `-rw-r--r--` (world-readable) | 🔎 audit approfondi |
| 14 | 🟡 MOYEN | `.env` | Secrets de prod en clair ; `FRONT_API_TOKEN` défini mais **jamais câblé** (garde-fou d'auth prévu puis oublié) | 🔎 audit approfondi |
| 15 | 🟢 FAIBLE | `omni/copros.ts:86-87` | Bounding box `cos(lat)→0` : OK métropole, casse en DOM-TOM / coord corrompue | 🔎 audit approfondi |
| 16 | 🟢 FAIBLE | `email/gmailRaw.ts:5` | `From` display-name non encodé RFC 2047 (OK en ASCII, casse si accentué) | ✅ vérifié |
| 17 | 🟢 FAIBLE | `index.ts` | Pas de `helmet`/CSP, pas de handler `unhandledRejection`/`uncaughtException` | ✅ vérifié |

## Détail par thème

### A. Sécurité / Auth / RGPD

- **#1 — Pas d'auth.** Les trois routers sont montés sans middleware (`app.use('/api', biensRouter)`). `GET /api/biens/:ref` renvoie emails + noms de copropriétaires ; `POST /api/biens/:ref/envoyer` déclenche de vrais envois. En prod, c'est ouvert. Le `.env` contient déjà un `FRONT_API_TOKEN` (jamais lu nulle part) : l'intention existait. → **Câbler ce token en middleware**, ou réutiliser le SSO Google.
- **#6 — Désinscription.** Un GET qui écrit en base est déclenchable par le prefetch des clients mail / antivirus → désinscription involontaire et **irréversible** (`INSERT OR IGNORE`, aucune réinscription). → Page de confirmation en GET, write en POST + permettre la réinscription.
- **#7 — OAuth.** `state` anti-CSRF présent mais stocké dans une `Map` process, non lié à un cookie de session → login-CSRF possible (un tiers fait connecter *son* compte d'envoi). Le `catch` final reflète `e.message` en HTML brut.
- **#13/#14 — Données & secrets.** `data/app.db` lisible par tout utilisateur local ; `.env` de prod en clair contient la clé de déchiffrement des refresh tokens + l'URL Postgres CRM. → `chmod 600`, segréguer les secrets.

### B. Fiabilité / API Netty / Envois

- **#2 — La cause racine du 401.** `modeloGet` jette tout `4xx` immédiatement (donc 401/429) sans lire `Retry-After`, **sans timeout** (un socket pendu sous throttle fige le poll), et la pagination enchaîne `/products` puis jusqu'à **6 pages `/affairs`** dos-à-dos sans pause. Le code *fabrique* la rafale qu'il prétend éviter. → `Retry-After` + `AbortController` + **circuit-breaker global** « clé throttlée jusqu'à T » + pause entre pages. (`MODELO_AFFAIRS=1` par défaut : envisager OFF tant que la clé n'est pas stabilisée.)
- **#3/#4 — Double-envoi & rafales.** `canal.envoyer()` puis `recordEnvoi()` puis `marquerFile()` ne sont pas atomiques : un crash entre l'envoi et le marquage laisse la ligne `en_attente` **sans trace dans `envois`** → ré-envoi au prochain passage. Trois déclencheurs (`cron 09:00`, rattrapage `+8 s`, `POST /api/file/traiter`) peuvent lire le même lot dû en parallèle. Le rattrapage au boot draine **tout** l'arriéré (`fileDue(today)`) sans le cap 30/j. → Réservation atomique `UPDATE … SET statut='en_cours' WHERE id=? AND statut='en_attente'` (traiter si `changes===1`) + garde de réentrance + cap 30/j appliqué **au drain**.

### C. Email / Délivrabilité

- **#5 — One-click unsubscribe.** Ni `List-Unsubscribe` ni `List-Unsubscribe-Post` ne sont posés (Gmail comme Resend), **et** il n'existe pas de route `POST /desinscription`. Pour du cold-mail B2C en volume (exigences Gmail/Yahoo « bulk sender »), c'est le défaut le plus pénalisant → plaintes spam au lieu de désinscriptions. → Ajouter les deux en-têtes + une route POST one-click (garder le GET pour le clic humain).
- **#9 — Encodage.** Corps `charset=UTF-8` mais `Content-Transfer-Encoding: 7bit` alors qu'il contient des accents et « → »/« m² ». Gmail re-encode souvent, mais c'est non conforme (mojibake possible côté Resend/MTA stricts). → `base64` ou `quoted-printable`.
- **#16 — `From`.** Le nom d'expéditeur n'est pas encodé RFC 2047 : OK pour « Matera Transaction », casse si un jour accentué.
- **Photo en URL distante** (bucket Scaleway) plutôt qu'en CID : souvent bloquée par défaut + profil cold-mail. À assumer (URL) ou attacher en CID.

## Zones SAINES (confirmées)

- **`agents/tokenCrypto.ts`** : AES-256-GCM, clé 32 octets validée, **IV aléatoire unique** par chiffrement, tag d'authentification posé **et vérifié**. RAS.
- **Injection SQL** : tout est paramétré (SQLite prepared `?`/`@`, Postgres `$1`). Aucune concaténation.
- **Restriction de domaine** : le callback OAuth rejette tout email non `@matera.eu` avant stockage.
- **Opt-out dans le corps** : présent dans chaque mail (HTML + texte), token unique par envoi. (Le manque est l'en-tête one-click, cf. #5.)
- **Injection d'en-tête via nom du copropriétaire** : non exploitable — le `prenom`/`nom` Omni est persisté mais jamais réinjecté dans les en-têtes MIME ni le corps ; le `To` est validé `.email()`.

## Plan de remédiation proposé (ordre)

1. **Débloquer Netty durablement** (#2) — circuit-breaker + `Retry-After` + timeout + pause pagination. *C'est ce qui fait repartir tout le reste.*
2. **Fiabiliser les envois** (#3, #4) — réservation atomique + garde de réentrance + cap 30/j au drain. *À faire avant tout passage `ENVOI_SANDBOX=0`.*
3. **Authentifier l'API** (#1) — câbler `FRONT_API_TOKEN` (déjà dans `.env`) en middleware.
4. **Conformité cold-email** (#5, #6) — `List-Unsubscribe` + route POST one-click + désinscription en POST réinscriptible.
5. **Robustesse** (#9, #10, #11, #12) — encodage email, garde `NaN` config, erreurs Omni non avalées, repli de canal.
6. **Durcissement** (#7, #13, #14, #16, #17) — XSS OAuth, permissions DB, secrets, en-têtes de sécurité.
