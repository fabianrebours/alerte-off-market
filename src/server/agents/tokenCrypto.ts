import crypto from 'node:crypto';
import { config } from '../config.ts';

/**
 * Chiffrement des refresh tokens Google — AES-256-GCM, format `enc:iv:tag:data`.
 * Même schéma que le CRM (GOOGLE_TOKEN_SECRET, clé hex 32 octets / 64 hex),
 * pour que les tokens restent interchangeables entre les deux systèmes.
 */

function cle(): Buffer | null {
  const s = config.google.tokenSecret;
  return s && s.length === 64 ? Buffer.from(s, 'hex') : null;
}

export function encryptToken(plain: string): string {
  const key = cle();
  if (!key) throw new Error('GOOGLE_TOKEN_SECRET absent ou invalide (64 hex attendus)');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${data.toString('hex')}`;
}

export function decryptToken(stored: string | null): string | null {
  if (!stored) return null;
  if (!stored.startsWith('enc:')) return stored; // legacy non chiffré
  const key = cle();
  if (!key) return null;
  try {
    const [, ivHex, tagHex, dataHex] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(dataHex, 'hex')).toString('utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}
