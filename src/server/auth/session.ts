import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';

/**
 * Jeton de session SSO : `payloadBase64url.signatureBase64url`.
 * Signé HMAC-SHA256 avec config.authSecret. Pas de dépendance JWT externe :
 * un outil interne, charge utile minimale (email + expiration).
 */
const TTL_MS = 12 * 60 * 60 * 1000; // 12 h

function signature(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** Émet un jeton de session pour un email (supposé déjà vérifié @matera.eu). */
export function signerSession(email: string, nowMs: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: nowMs + TTL_MS })).toString('base64url');
  return `${payload}.${signature(payload, config.authSecret)}`;
}

/** Vérifie signature + expiration + domaine. Retourne l'email, ou null si invalide. */
export function verifierSession(token: string): { email: string } | null {
  if (!config.authSecret || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const attendue = signature(payload, config.authSecret);
  const a = Buffer.from(sig), b = Buffer.from(attendue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { email?: unknown; exp?: unknown };
    if (typeof email !== 'string' || typeof exp !== 'number') return null;
    if (Date.now() > exp) return null;
    if (!email.endsWith('@matera.eu')) return null;
    return { email };
  } catch {
    return null;
  }
}
