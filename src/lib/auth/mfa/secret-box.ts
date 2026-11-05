/**
 * Chiffrement au repos des secrets TOTP — AES-256-GCM, clés HORS base
 * (lot 110B, ticket §5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VARIABLES SCALINGO
 *
 *   MFA_ENCRYPTION_KEYS        trousseau « id:clé » séparé par des virgules ;
 *                              chaque clé = 32 octets en base64 (ex.
 *                              `k2026a:<openssl rand -base64 32>`). Plusieurs
 *                              identifiants = rotation : les anciens restent
 *                              lisibles.
 *   MFA_ENCRYPTION_ACTIVE_KEY  identifiant de la clé qui CHIFFRE (défaut : le
 *                              premier du trousseau).
 *
 * Format stocké : `v1.<id>.<iv>.<tag>.<chiffré>` (base64url). Données
 * associées (AAD) : identifiant de l'utilisateur — un secret recopié sur la
 * ligne d'un autre utilisateur est indéchiffrable.
 *
 * ROTATION : ajouter la nouvelle clé au trousseau, la désigner active ;
 * chaque secret lu avec une ancienne clé est rechiffré avec l'active lors de
 * sa prochaine vérification réussie (`totp.ts`). Retirer l'ancienne clé
 * seulement quand le BO n'en compte plus aucun usage.
 *
 * Production sans trousseau valable : `MfaKeyUnavailableError` — l'enrôlement
 * TOTP est refusé (503 explicite), JAMAIS de repli sur une clé dérivée. Hors
 * production (développement, tests) : clé de développement dérivée de
 * JWT_SECRET (étiquette dédiée).
 *
 * Aucun secret, aucune clé, aucun chiffré n'est jamais journalisé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export class MfaKeyUnavailableError extends Error {
  constructor(reason: string) {
    super(`MFA_KEY_UNAVAILABLE: ${reason}`);
    this.name = 'MfaKeyUnavailableError';
  }
}

type Env = Record<string, string | undefined>;
interface KeyRing { active: string; keys: Map<string, Buffer> }

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Lecture du trousseau (jamais la valeur dans un message). */
export function readKeyRing(env: Env = process.env): KeyRing {
  const raw = (env.MFA_ENCRYPTION_KEYS ?? '').trim();
  const keys = new Map<string, Buffer>();
  if (raw) {
    for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
      const i = part.indexOf(':');
      const id = i > 0 ? part.slice(0, i) : '';
      const b = i > 0 ? Buffer.from(part.slice(i + 1), 'base64') : Buffer.alloc(0);
      if (!ID_RE.test(id) || b.length !== 32) throw new MfaKeyUnavailableError('MFA_ENCRYPTION_KEYS mal formé (attendu id:clé base64 de 32 octets)');
      keys.set(id, b);
    }
  }
  if (keys.size === 0) {
    if (env.NODE_ENV === 'production') throw new MfaKeyUnavailableError('MFA_ENCRYPTION_KEYS absent');
    const base = (env.JWT_SECRET || 'dev-only').trim();
    keys.set('dev', createHmac('sha256', base).update('verebona/mfa/totp-secret/dev-key/v1').digest());
  }
  const wanted = (env.MFA_ENCRYPTION_ACTIVE_KEY ?? '').trim();
  const active = wanted || [...keys.keys()][0];
  if (!keys.has(active)) throw new MfaKeyUnavailableError('MFA_ENCRYPTION_ACTIVE_KEY ne désigne aucune clé du trousseau');
  return { active, keys };
}

/** État pour le BO (aucune valeur) : configuré, identifiant actif, identifiants connus. */
export function keyRingStatus(env: Env = process.env): { configured: boolean; activeKeyId: string | null; keyIds: string[]; problem: string | null } {
  try {
    const r = readKeyRing(env);
    const configured = !!(env.MFA_ENCRYPTION_KEYS ?? '').trim();
    return { configured, activeKeyId: r.active, keyIds: [...r.keys.keys()], problem: null };
  } catch (e) {
    return { configured: false, activeKeyId: null, keyIds: [], problem: (e as Error).message.replace(/^MFA_KEY_UNAVAILABLE: /, '') };
  }
}

const aad = (userId: number) => Buffer.from(`verebona/mfa-totp/v1:${userId}`, 'utf8');

export function sealSecret(plain: string, userId: number, env: Env = process.env): { sealed: string; keyId: string } {
  const ring = readKeyRing(env);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', ring.keys.get(ring.active)!, iv);
  c.setAAD(aad(userId));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const b = (x: Buffer) => x.toString('base64url');
  return { sealed: `v1.${ring.active}.${b(iv)}.${b(c.getAuthTag())}.${b(enc)}`, keyId: ring.active };
}

/** Déchiffre ; `null` si illisible (clé retirée, donnée altérée, autre utilisateur). */
export function openSecret(sealed: string, userId: number, env: Env = process.env): { plain: string; keyId: string; stale: boolean } | null {
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, keyId, iv, tag, data] = parts;
  const ring = readKeyRing(env);
  const key = ring.keys.get(keyId);
  if (!key) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(aad(userId));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
    return { plain, keyId, stale: keyId !== ring.active };
  } catch {
    return null;
  }
}
