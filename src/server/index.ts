import express from 'express';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, statutIntegrations } from './config.ts';
import { biensRouter } from './routes/biens.ts';
import { optoutRouter } from './routes/optout.ts';
import { oauthRouter } from './routes/oauth.ts';
import { trackingRouter } from './routes/tracking.ts';
import { demarrerCronModelo } from './modelo/poller.ts';
import { demarrerCronFileAttente } from './email/fileAttente.ts';
import { delegationDisponible } from './email/gmailDelegation.ts';
import './db.ts'; // init du schéma SQLite au démarrage

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false })); // désinscription un-clic (POST form / RFC 8058)

// En-têtes de sécurité (équivalent minimal de helmet, sans dépendance).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});

/**
 * Auth API : jeton Bearer comparé à `FRONT_API_TOKEN` (temps constant).
 * Vide → API ouverte (dev local). Protège TOUT /api, y compris /api/statut.
 */
function verifierToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const attendu = config.frontApiToken;
  if (!attendu) return next();
  const fourni = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(fourni), b = Buffer.from(attendu);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Accès non autorisé : jeton manquant ou invalide.' });
}
app.use('/api', verifierToken);

// État des intégrations (bandeau UI).
app.get('/api/statut', (_req, res) => {
  res.json({ ...statutIntegrations(), gmailDelegation: delegationDisponible(), nbCoprosVoisines: config.nbCoprosVoisines });
});

app.use('/api', biensRouter);
app.use('/', optoutRouter);
app.use('/', oauthRouter);
app.use('/', trackingRouter); // /o (pixel ouverture) + /c (redirection clic)

// Sert le build front en production (dist/web). En dev, c'est Vite qui sert.
const webDist = resolve(here, '../../dist/web');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/desinscription' || req.path.startsWith('/oauth')
      || req.path === '/o' || req.path === '/c') return next();
    res.sendFile(resolve(webDist, 'index.html'));
  });
}

// Filets de sécurité process : on logue au lieu de planter en silence.
process.on('unhandledRejection', (raison) => {
  console.error('[process] rejet de promesse non géré :', raison instanceof Error ? (raison.stack ?? raison.message) : raison);
});
process.on('uncaughtException', (err) => {
  console.error('[process] exception non capturée :', err.stack ?? err.message);
  process.exit(1); // état potentiellement corrompu → redémarrage propre (file d'attente sûre au boot)
});

app.listen(config.port, () => {
  const s = statutIntegrations();
  console.log(`\n▶ Alerte off-market — http://localhost:${config.port}`);
  console.log(`  Intégrations : Modelo ${s.modelo ? '✓' : '✗'} · Omni ${s.omni ? '✓' : '✗'} · Resend ${s.resend ? '✓' : '✗'}`);
  console.log(`  Envoi : ${s.sandbox ? `BAC À SABLE → ${config.testRecipient}` : 'RÉEL'}\n`);
  demarrerCronModelo();
  demarrerCronFileAttente();
});
