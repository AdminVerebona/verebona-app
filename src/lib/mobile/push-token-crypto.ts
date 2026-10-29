/**
 * Chiffrement au repos des jetons push mobiles — lot 97 (CDC 12 §18.1,
 * §24 SEC-07, §26 « Push token »).
 *
 * Un jeton FCM/APNs permet d'envoyer une notification sur le téléphone de
 * quelqu'un : c'est une donnée de capacité. Il est stocké CHIFFRÉ
 * (AES-256-GCM, IV aléatoire, format `v1:<iv>:<tag>:<chiffré>` en base64url)
 * et accompagné d'une EMPREINTE (SHA-256) qui sert à retrouver un même jeton
 * sur une autre installation sans le déchiffrer.
 *
 * Clé : dérivée (HKDF-SHA256, libellé dédié) de `MOBILE_PUSH_TOKEN_KEY` si
 * posée, sinon de `JWT_SECRET` (toujours présente : aucune variable nouvelle
 * obligatoire). Changer la source rend les jetons existants illisibles :
 * l'installation passe `invalid_token` à son prochain envoi et l'application
 * réenregistre son jeton à son ouverture suivante (enregistrement à chaque
 * démarrage) — aucune donnée perdue, le push reprend seul.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const INFO = 'verebona:mobile-push-token:v1';

function cle(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Buffer {
  // Hors production seulement (développement, tests), même règle que les
  // jetons de session (`lib/jwt.ts`) : une valeur de développement fixe. En
  // production, JWT_SECRET est garanti par le contrôle de démarrage.
  const source = env.MOBILE_PUSH_TOKEN_KEY?.trim() || env.JWT_SECRET?.trim()
    || (env.NODE_ENV !== 'production' ? 'verebona-dev-only-push-token-key' : '');
  if (!source) throw new Error('MOBILE_PUSH_TOKEN_KEY / JWT_SECRET absents : chiffrement des jetons push impossible');
  return Buffer.from(hkdfSync('sha256', Buffer.from(source, 'utf8'), Buffer.alloc(0), Buffer.from(INFO, 'utf8'), 32));
}

/** Empreinte stable d'un jeton (recherche de doublon), jamais réversible. */
export function pushTokenHash(token: string): string {
  return createHash('sha256').update(`push-token:${token}`, 'utf8').digest('hex');
}

export function encryptPushToken(token: string, env?: Record<string, string | undefined>): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cle(env), iv);
  const chiffre = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), chiffre.toString('base64url')].join(':');
}

/** Jeton en clair, ou null si illisible (clé changée, valeur altérée). */
export function decryptPushToken(value: string | null | undefined, env?: Record<string, string | undefined>): string | null {
  if (!value) return null;
  const [v, iv, tag, data] = value.split(':');
  if (v !== VERSION || !iv || !tag || !data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', cle(env), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
