# CLAUDE.md — CRM Immobilier Matera (v2)

Contexte indispensable pour Claude Code. À relire au début de chaque session.

## ⚡ Protocole de session (2026-06-11) — À FAIRE EN PREMIER

1. **Lire la note de passation la plus récente** dans `Pietra/Claude/Sessions/` (vault Obsidian de ce dossier) — elle porte l'état en cours et prime sur les souvenirs.
2. Protocole complet : `Pietra/Claude/Protocole sessions.md`. Résumé : sessions courtes (un chantier), **à ~50 % de contexte consommé** → écrire la note de passation, pousser ce qui est vert sur main, **supprimer le worktree/la branche**, demander à Fabian de repartir sur une session neuve. Max ~5 worktrees vivants, jamais de branche zombie.
3. Avant tout push : `tsc --noEmit` + vitest du périmètre ; migrations testées en `BEGIN/ROLLBACK` ; merger `origin/main` d'abord (sessions parallèles).

## Projet

**CRM immobilier interne pour le réseau de mandataires Matera Transaction.**
Remplace le CRM actuel. S'intègre à la plateforme acheteurs/leads existante.

Maintenu par Fabian Rebours (admin/dev). Source de vérité = `PLAN_CRM_IMMO_V2.md`.

## Stack & conventions

### Frontend
- React 18 + TypeScript + Vite
- Tailwind CSS + Lucide React
- React Router v6
- TanStack Query (état serveur)
- react-hook-form + zod
- **Composants UI custom** dans `shared/components/ui/` — pas de framework lourd

### Backend
- Node.js + Express + TypeScript
- PostgreSQL (Render) via driver `pg` natif
- **SQL brut paramétré** (`$1, $2`) — JAMAIS d'ORM, JAMAIS de concat
- Auth Google SSO via `google-auth-library`
- JWT + refresh tokens (issus du SSO)
- Header `X-Agent-Id`

### Infra
- Render (1 web service backend + PostgreSQL)
- node-cron embarqué dans le serveur
- 2 repos GitHub : `crm-frontend` (nouveau) + `crm-server` (existant, ajout dans `modules/crm/`)
- **Pas de Docker** — Render gère le déploiement

### Stockage
- Scaleway Object Storage (Paris, RGPD natif)
- 2 buckets : `crm-immo-{env}` (photos) + `crm-tracfin-{env}` (privé strict)
- SDK `@aws-sdk/client-s3` (compatible)

## Architecture modulaire — règles absolues

### 5 modules métier + 3 transverses
Métier : `biens`, `mandats`, `offres`, `tracfin`, `commissions`
Transverses : `auth`, `signature`, `audit`

### Pattern Ports & Adapters
- Chaque module définit ses **ports** (interfaces TS) dans `ports/`
- Chaque module fournit un **adapter local** dans `modules/X/adapters/`
- Tout autre module qui a besoin de X passe par `XPort`, JAMAIS par import direct
- Le bootstrap (`server.ts`) crée les adapters et les injecte par constructor

### Anti-escalade — interdictions
❌ `import { ... } from '../../biens/services/...'` dans un autre module
❌ Reaching into another module's internals
❌ Module qui exporte plus que son port public
❌ Couplage circulaire entre modules

✅ `import { BiensPort } from '../../../ports/biens.port'`
✅ Recevoir le port via constructor injection
✅ Tester un module avec un mock de port

### Conséquence : si demain on splitte un module en service séparé, on remplace juste l'adapter local par un adapter HTTP. Le reste du code ne bouge pas.

## Sécurité — règles non négociables

### Auth
- **Google SSO uniquement** restreint au domaine `matera.eu`
- Vérification que l'email existe dans `users` (invitation préalable obligatoire)
- Pas de mot de passe stocké, pas de page reset, pas de MFA à coder

### RLS PostgreSQL
- Tables sensibles ont `ENABLE ROW LEVEL SECURITY`
- À chaque requête, exécuter `SET LOCAL app.current_user_id` via `withUserScope()`
- Si on oublie le SET, les SELECT renvoient 0 ligne (sécurité par défaut)
- Admin réseau : `SET LOCAL app.is_admin = 'true'` pour bypass

### Audit + alertes
- Toute action sensible loggée dans `crm.audit_logs`
- Job cron toutes les 10 min détecte anomalies → notif Slack
- Anomalies surveillées : exports massifs, accès anormaux Tracfin, nouveau pays, scope violations

### Chiffrement
- Champs sensibles Tracfin (adresse, n° pièce ID, origine fonds) chiffrés AES-256-GCM avant insert
- Clé dans env (`TRACFIN_ENCRYPTION_KEY` 32 bytes hex)
- Bucket Tracfin séparé + URLs signées 5 min seulement

## Conventions de code

- **Français partout** : code, commits, UI, emails, noms de variables métier
- **UUID v4** pour tous les IDs
- **Schema PostgreSQL `crm.`** : toutes les nouvelles tables
- **Soft delete** (`deleted_at`) — jamais de hard delete
- **Timestamps** automatiques via triggers
- **REST** : préfixe `/api/crm/`, JSON
- **Commits** en français : `feat(biens): ajout du filtre par statut`

## Ce qu'il ne faut PAS faire

❌ Next.js, Nuxt, Remix, Astro
❌ Prisma, Sequelize, TypeORM, Drizzle
❌ MongoDB, MySQL
❌ Docker
❌ Framework UI (MUI, Chakra, Mantine)
❌ SQL concaténé
❌ Hard delete
❌ Écrire dans `public.users` ou `public.acheteurs` sans accord explicite
❌ Imports inter-modules directs (passer par les ports)
❌ Hardcoder des secrets
❌ Skip la validation zod

## Ce que le CRM ne fait PAS (pour éviter de coder en trop)

- Pas de matching acheteurs/biens (déjà dans plateforme acheteurs)
- Pas de dashboard analytics (déjà via Modelo)
- Pas de génération d'annonces IA au MVP
- Pas d'app mobile native
- Pas d'espace client acheteur (lien unique par email uniquement)
- Pas de docs compromis/acte (le notaire gère tout)
- Pas de génération CR de visite (déjà dans plateforme)

## Documents Légaux — sources de vérité pour les templates de mandat

Les specs détaillées des templates Matera sont dans `Documents Légaux/` à la racine du projet :

- `Documents Légaux/spec_mandat_exclusif (1).md` — spec complète du mandat exclusif (sections 0–N, sous-modules conditionnels, prose littérale)
- `Documents Légaux/spec_mandat_simple.md` — spec mandat simple
- `Documents Légaux/spec_mandat_semi_exclusif.md` — spec mandat semi-exclusif
- `Documents Légaux/spec_avenant_mandat.md` — spec avenant

**Règle absolue** : avant toute modification d'une migration `template_matera_*`, du renderer, ou du HTML d'une section de mandat, **lire le spec concerné via Read**. La spec prime sur l'implémentation actuelle. Si l'implémentation diverge, c'est un bug — corriger l'implémentation, pas la spec.

## Comportement attendu de Claude Code

1. **Avant de coder** : lire la section concernée du `PLAN_CRM_IMMO_V2.md` ET, pour les mandats Matera, le spec correspondant dans `Documents Légaux/`
2. **En cas de doute** : poser la question, ne jamais supposer
3. **Migrations SQL** : montrer le contenu avant d'appliquer
4. **Templates HTML** (mandats, emails) : présenter pour validation
5. **Branches conditionnelles mandats** : présenter le JSON pour relecture
6. **Après chaque feature** : résumer ce qui a été fait + comment tester
7. **Pas d'initiatives non demandées** (lib externe, refacto, simplification de schéma...)
8. **Si Claude détecte une violation d'architecture** (import inter-modules), refuser et alerter

## Intégrations tierces clés

- **PandaDoc** : signature mandats + offres
- **Ubiflow Gens de Confiance** : multidiffusion XML
- **ADEME** : DPE/GES auto
- **IGN/Géoportail** : cadastre + géocodage
- **DVF** : valeurs foncières
- **Resend** : emails transactionnels
- **Scaleway Object Storage** : fichiers
- **Google Calendar** : RDV visites
- **Slack** : alertes sécurité (réutiliser conf existante)

## Constantes Matera (à seeder dans `crm.reseau_config`)

- Raison sociale : MATERA
- Forme : SAS
- Capital : 70 080 €
- Siège : 8 Cité Paradis 75010 Paris
- RCS : Tous Paris n°825188576
- TVA : FR28825188576
- Carte T : CPI75012022000000632 (CCI Paris Île-de-France)
- RC Pro : AIG Europe SA, Tour CBX, 1 Passerelle des Reflets 92400 Courbevoie
- Garantie financière : Groupement Français de Caution, 7 Chemin de la Dhuy 38240 Meylan, n°1-11970-14946-0
- Médiateur : SAS MEDIATION SOLUTION, 222 chemin de la bergerie 01800 Saint-Jean-de-Niost
- Email transactions : transactions@matera.eu
- Email sécurité : securite@matera.eu (à créer)

## Questions ouvertes à reposer

Si tu rencontres ces zones grises pendant l'implémentation, demande à Fabian :
- Honoraires HT ou TTC pour base de calcul commissions ?
- Durée min/max contraints par type de mandat ?
- Mandataire désactivé : que faire de ses biens en cours ?
- Multi-agences : un mandataire peut-il appartenir à plusieurs ?
- Grille honoraires standard du réseau ?
