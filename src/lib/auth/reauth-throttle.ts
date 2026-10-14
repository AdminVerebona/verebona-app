/**
 * Limitation de la RÉAUTHENTIFICATION par mot de passe — lot 53A (retour PO
 * Q21) ; CDC 18 §33 (« Reauth password : même niveau de protection que login
 * + user/session key » ; « Account deletion : conserver rate limiting IP +
 * user »), SEC-04 (compteurs partagés entre instances).
 *
 * Actions concernées : changement du mot de passe (mot de passe actuel) et
 * clôture du compte (mot de passe + « SUPPRIMER MON COMPTE »). Une session
 * volée ne doit pas servir à deviner le mot de passe.
 *
 *   · compteurs PARTAGÉS (`auth_rate_limits`) — la clôture utilisait un `Map`
 *     en mémoire par instance ;
 *   · seuls les ÉCHECS de mot de passe comptent ;
 *   · clé par UTILISATEUR (5 échecs / 15 min → 15, 30, 60 min) et par IP
 *     (20 / 15 min). Une session est exigée : aucun tiers ne peut bloquer le
 *     titulaire par ce chemin ;
 *   · réussite : le compteur de l'utilisateur repart à zéro ;
 *   · pause déclenchée : journal AUTH_REAUTH_THROTTLED.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, rateLimitBody } from './auth-rate-limit';
import { getClientIp } from './client-ip';
import { logUserActivity } from '@/lib/audit-logger';

export type ReauthAction = 'change_password' | 'account_deletion';

function entries(userId: number, ip: string) {
  return [
    { key: limitKey('reauth', 'user', String(userId)), policy: AUTH_LIMITS.reauthUser },
    { key: limitKey('reauth', 'ip', ip), policy: AUTH_LIMITS.reauthIp },
  ];
}

/** Réponse 429 si une pause est en cours ; `null` sinon. Ne compte rien. */
export async function reauthBlockedResponse(request: NextRequest, userId: number): Promise<NextResponse | null> {
  if (!authRateLimitEnabled()) return null;
  const d = await getAuthRateLimiter().check(entries(userId, getClientIp(request.headers)));
  if (d.allowed) return null;
  return NextResponse.json(rateLimitBody(d.retryAfterSeconds), {
    status: 429, headers: { 'Retry-After': String(d.retryAfterSeconds) },
  });
}

/** Mot de passe actuel faux : compté (utilisateur et IP). */
export async function recordReauthFailure(request: NextRequest, userId: number, action: ReauthAction): Promise<void> {
  if (!authRateLimitEnabled()) return;
  const d = await getAuthRateLimiter().recordFailure(entries(userId, getClientIp(request.headers)));
  if (d.lockedNow) {
    void logUserActivity({
      activityType: 'AUTH_REAUTH_THROTTLED',
      userId,
      userEmail: '',
      details: { action, retryAfterSeconds: d.retryAfterSeconds },
      request,
    });
  }
}

/** Mot de passe prouvé : le compteur de l'utilisateur repart à zéro (jamais celui de l'IP). */
export async function recordReauthSuccess(userId: number): Promise<void> {
  if (!authRateLimitEnabled()) return;
  await getAuthRateLimiter().reset(limitKey('reauth', 'user', String(userId)));
}
