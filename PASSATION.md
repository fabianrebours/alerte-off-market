# Note de passation — Alerte off-market

_Dernière mise à jour : 2026-06-25 (session design + audit + remédiation)_

## En une phrase
Outil **standalone** (Node/Express + React/Vite + SQLite) qui détecte les biens **off-market récents** sur **Modelo/Netty**, croise avec les **copropriétés Matera voisines** (Omni) pour récupérer les **emails des copropriétaires**, et envoie un **mail simple « de la part de l'agent »** (validé par l'agent, étalé 30/jour, opt-out RGPD).

## Ce qui a été fait cette session
1. **Refonte design — charte Matera / service Transaction (bordeaux).** Palette `matera-*` repointée bleu→bordeaux + scales `bordeaux`/`sable` + `creme`/`pale` (`tailwind.config.js`). Vert→bordeaux, bleu→sable, ambre conservé (= jaune pâle Transaction), rouge = erreurs. **Zéro bleu, zéro vert.** UI + pages servies (OAuth, désinscription) + liens email. Vérifié visuellement (`design-bordeaux-liste.png`).
2. **Audit poussé → `AUDIT.md`** (17 findings priorisés, vérifiés sur le code réel) + **statut de remédiation**.
3. **Remédiation complète (plan en 6 étapes du `AUDIT.md`)** — implémentée ET vérifiée (`tsc` 0 erreur, build, boot serveur, auth 401/200, MIME décodé) :
   - **Netty** : circuit-breaker (clé throttlée → court-circuit), `Retry-After`, timeout 15 s, pause pagination. *Le code ne martèle plus la clé.*
   - **Envois fiables** : réservation atomique (`en_cours`) + garde de réentrance + finalisation transactionnelle + reclaim au boot + **cap 30/j appliqué au drain** + verrou anti double-clic.
   - **Auth API** : middleware Bearer (`FRONT_API_TOKEN`) + portail de saisie du jeton dans l'UI.
   - **Cold-email** : `List-Unsubscribe` + `List-Unsubscribe-Post` (one-click RFC 8058, Gmail + Resend), opt-out **POST** (GET = page de confirmation anti-prefetch), encodage **base64** + **RFC 2047** (accents), multipart texte+html.
   - **Robustesse** : garde `NaN` config (`numEnv`), erreurs Omni propagées (502), repli de canal au runtime.
   - **Durcissement** : échappement XSS pages OAuth, en-têtes sécurité (nosniff, X-Frame-Options, CSP frame-ancestors, Referrer-Policy), handlers `unhandledRejection`/`uncaughtException`, `chmod 600` sur `data/app.db`.

## ⚠️ État Netty (le seul vrai bloquant restant — EXTERNE)
La clé Netty est **toujours throttlée (401)** — reset quota côté Netty (journalier), hors de notre contrôle. **Mais l'outil ne perpétue plus le throttle** (vérifié : 1 appel → 401 → breaker armé → appels suivants court-circuités 0 ms). La clé a donc une vraie fenêtre de récupération.
- **À faire** : cliquer **« Rafraîchir Modelo »** (POST /api/poll) → ça **réinitialise le breaker** et force un essai réel. Si 200 → biens + badge mandat se peuplent. Si encore 401 → message clair « réessaie dans ~15 min ».

## ⚠️ Nouveau depuis cette session : auth API
Après redémarrage du serveur (nouveau code), **l'UI demande le `FRONT_API_TOKEN`** au 1er accès (collé une fois, gardé dans le navigateur). Le jeton est dans `.env` (et `.env.example` documente `openssl rand -hex 32`). Tant que `FRONT_API_TOKEN` est vide, l'API reste ouverte (dev local).

## Crons (inchangés)
- **Poll Modelo** : tous les jours à **06:00** (`0 6 * * *`) — `src/server/modelo/poller.ts`. Pas de poll au démarrage.
- **File d'envoi** : tous les jours à **09:00** (`0 9 * * *`) + rattrapage au démarrage — `src/server/email/fileAttente.ts`. Désormais : réentrance + reclaim + cap 30/j global au drain.

## Prochaines étapes
1. Débloquer/attendre la clé Netty → **« Rafraîchir Modelo »** → vérifier biens + badge mandat.
2. **Test d'envoi** en bac à sable (1 bien) → vérifier `From: transactions@matera.eu`, distance, signature, lien LP, **et le bouton « Se désinscrire » natif de Gmail** (List-Unsubscribe one-click).
3. Passer `ENVOI_SANDBOX=0` pour le réel.
4. **Opérationnel** : faire tourner/segréguer les secrets de prod du `.env` (#14 de l'audit — hors code).
5. (Option) Déploiement Render (web service Node + disque SQLite, ou migration Postgres).

## Lancer
```bash
cd "/Users/fabian/Desktop/Claude Code/Envoyer un mail en off market "
npm run dev        # API 8787 + front 5173 (hot reload)  → http://localhost:5173
# ou : npm start   # tout sur http://localhost:8787 (front compilé)
```
> Note dev : si le backend (8787) est éteint, le proxy Vite intercepte `/api.ts` et la page reste blanche. Pour voir le front seul, utiliser `npx vite preview` (build statique, sans proxy).

## .env (clés)
`MODELO_API_KEY`, `OMNI_API_KEY`/`OMNI_MODEL_ID`. `EXPEDITEUR_EMAIL=transactions@matera.eu`. Gmail agent : `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_TOKEN_SECRET` (+ compte connecté via UI). **`FRONT_API_TOKEN`** (auth API — `openssl rand -hex 32`). Réglages : `RECENCE_JOURS=30`, `COOLDOWN_JOURS=7`, `TAILLE_LOT_ENVOI=30`, `NB_COPROS_VOISINES=5`, `LP_BASE_URL`, `MODELO_AFFAIRS=1`, `ENVOI_SANDBOX=1`.

## Sources de vérité
- **Biens** : Modelo/Netty (`/products`). Mandats : Netty (`/affairs`). Base SQLite locale = cache + état.
- **Copros + emails** : Omni (entrepôt Matera). Géocodage repli : BAN.
- **Audit & remédiation** : `AUDIT.md`.

## Fichiers clés
`src/server/modelo/{client,poller,types}.ts` · `src/server/omni/copros.ts` · `src/server/email/{template,canal,gmail,gmailDelegation,gmailRaw,fileAttente,provider}.ts` · `src/server/routes/{biens,oauth,optout}.ts` · `src/server/{db,config,index}.ts` · `src/web/{App,api}.tsx` + `src/web/components/`. Doc : `README.md`, `AUDIT.md`.
