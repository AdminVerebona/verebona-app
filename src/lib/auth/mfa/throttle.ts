/**
 * Limitation des vérifications de second facteur (lot 110B, ticket §5) —
 * compteurs PARTAGÉS en base (`auth_rate_limits`, limiteur du lot 37/53A),
 * par COMPTE et par IP. Seuls les ÉCHECS comptent ; une réussite remet le
 * compteur du compte à zéro. Pause déclenchée : journal MFA_THROTTLED.
 * Aucune clé ni valeur en clair dans la table (HMAC, `limitKey`).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, rateLimitBody } from '../auth-rate-limit';
import { getClientIp } from '../client-ip';
import { logUserActivity } from '@/lib/audit-logger';
import { MFA_MESSAGES } from './constants';

function entries(userId: number | null, ip: string) {
  return [
    ...(userId != null ? [{ key: limitKey('mfa', 'user', String(userId)), policy: AUTH_LIMITS.mfaUser }] : []),
    { key: limitKey('mfa', 'ip', ip), policy: AUTH_LIMITS.mfaIp },
  ];
}

function tooMany(retryAfterSeconds: number): NextResponse {
  return NextResponse.json({ ...rateLimitBody(retryAfterSeconds), message: MFA_MESSAGES.rateLimited }, {
    status: 429, headers: { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' },
  });
}

/** 429 si une pause est en cours ; `null` sinon (ne compte rien). */
export async function mfaBlockedResponse(request: NextRequest, userId: number | null): Promise<NextResponse | null> {
  if (!authRateLimitEnabled()) return null;
  const d = await getAuthRateLimiter().check(entries(userId, getClientIp(request.headers)));
  return d.allowed ? null : tooMany(d.retryAfterSeconds);
}

/** Échec compté (compte et IP) ; journal sans aucune valeur saisie. */
export async function recordMfaFailure(request: NextRequest, userId: number | null, method: string): Promise<void> {
  void logUserActivity({ activityType: 'MFA_FAILED', userId, userEmail: '', details: { method }, request });
  if (!authRateLimitEnabled()) return;
  const d = await getAuthRateLimiter().recordFailure(entries(userId, getClientIp(request.headers)));
  if (d.lockedNow) {
    void logUserActivity({ activityType: 'MFA_THROTTLED', userId, userEmail: '', details: { method, retryAfterSeconds: d.retryAfterSeconds }, request });
  }
}

export async function recordMfaSuccess(userId: number): Promise<void> {
  if (!authRateLimitEnabled()) return;
  await getAuthRateLimiter().reset(limitKey('mfa', 'user', String(userId)));
}

/** Demandes de code de récupération par e-mail : par adresse (silencieux) et par IP (429). */
export async function consumeRecoveryEmailQuota(request: NextRequest, email: string): Promise<{ ipBlocked: NextResponse | null; accountAllowed: boolean }> {
  if (!authRateLimitEnabled()) return { ipBlocked: null, accountAllowed: true };
  const l = getAuthRateLimiter();
  const ip = await l.consume([{ key: limitKey('mfa', 'ip', `recovery:${getClientIp(request.headers)}`), policy: AUTH_LIMITS.mfaRecoveryIp }]);
  if (!ip.allowed) return { ipBlocked: tooMany(ip.retryAfterSeconds), accountAllowed: false };
  const acct = await l.consume([{ key: limitKey('mfa', 'acct', email), policy: AUTH_LIMITS.mfaRecoveryAccount }]);
  return { ipBlocked: null, accountAllowed: acct.allowed };
}
