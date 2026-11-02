/**
 * Instant d'usage d'un lien de parrainage — lot 102D (fenêtre d'attribution
 * de 90 jours : « lien utilisé → inscription dans les 90 jours »).
 *
 * Le CDC parrainage §4.2 interdit tout cookie ou stockage persistant du code :
 * il ne circule que par l'URL. `/r/<code>` ajoute donc à la redirection un
 * jeton `rt=<secondes>.<signature>` qui atteste QUAND ce lien a été suivi, et
 * pour QUEL code (HMAC-SHA256, secret serveur). Le formulaire d'inscription
 * (et le parcours Google / Apple) le renvoie tel quel ; le serveur le vérifie :
 *   · jeton valide pour ce code → instant d'usage = instant signé ;
 *   · absent, illisible, signé pour un autre code (code modifié à la main) →
 *     le code est réputé utilisé à l'inscription (saisie manuelle).
 * Le jeton ne donne aucun droit : il ne peut que RÉDUIRE une attribution.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const PURPOSE = 'verebona:referral-touch:v1';
const INSECURE_DEFAULT_SECRET = 'your-secret-key-change-in-production';

type Env = Record<string, string | undefined>;

function secret(env: Env = process.env): string | null {
  const s = (env.REFERRAL_TOUCH_SECRET || env.JWT_SECRET || '').trim();
  if (env.NODE_ENV === 'production' && (!s || s === INSECURE_DEFAULT_SECRET)) return null;
  return s || INSECURE_DEFAULT_SECRET;
}

function sign(code: string, seconds: number, key: string): string {
  return createHmac('sha256', key).update(`${PURPOSE}:${code}:${seconds}`).digest('base64url').slice(0, 22);
}

/** Jeton d'usage du lien `code` à `now` ; `null` sans secret exploitable. */
export function createReferralTouch(code: string, now: Date = new Date(), env?: Env): string | null {
  const key = secret(env);
  if (!key) return null;
  const s = Math.floor(now.getTime() / 1000);
  return `${s}.${sign(code, s, key)}`;
}

/** Instant signé si le jeton est valide POUR CE CODE, sinon `null`. */
export function verifyReferralTouch(code: string | null, token: unknown, env?: Env): Date | null {
  if (!code || typeof token !== 'string' || token.length > 64) return null;
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{22})$/.exec(token.trim());
  if (!m) return null;
  const key = secret(env);
  if (!key) return null;
  const expected = Buffer.from(sign(code, Number(m[1]), key));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return new Date(Number(m[1]) * 1000);
}
