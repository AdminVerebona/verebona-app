/**
 * Contrôle serveur d'un jeton d'accès — pour les routes qui ne passent pas
 * par `SessionService.getSession` (`getCurrentUser`, et les routes qui
 * vérifient le jeton elles-mêmes via `extractAccessToken` +
 * `verifyAccessToken`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Ces routes ne vérifiaient que la signature et l'expiration du jeton : un
 * jeton émis AVANT une révocation globale (changement de mot de passe,
 * clôture du compte pour suppression) restait accepté jusqu'à son
 * expiration (15 min) sur un autre appareil. Elles appliquent désormais les
 * mêmes règles que `SessionService` :
 *   - borne de révocation de l'utilisateur (même cache de 60 s, vidé
 *     localement à la révocation) ;
 *   - compte suspendu / supprimé refusé ;
 *   - compte clôturé (PENDING_DELETION) : seules les routes de
 *     `lib/auth/account-closure` restent ouvertes.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { NextRequest } from 'next/server';
import { getUserSessionCutoff, isIssuedBefore } from '@/db';
import { verifyAccessToken, type AccessTokenPayload } from '@/lib/jwt';
import { isMutatingMethod, serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import { CGUV_REACCEPTANCE_REQUIRED_CODE, isApiAllowedDuringReacceptance } from '@/lib/legal/reacceptance-gate';
import { sessionCutoffCacheKey } from './session-cutoff';
import { isApiAllowedWhilePendingDeletion, isPendingDeletion } from './account-closure';
import { SESSION_UNAVAILABLE_CODE } from './session-errors';
import { hasActiveAccountAccess } from './account-access';
import { isSessionRevoked } from './session-registry';
import { assertMfaSatisfied } from './mfa/guard';

/**
 * Jeton émis avant la révocation globale de son utilisateur ? (borne en cache 60 s)
 *
 * ⚠️ Base injoignable : lève `SESSION_UNAVAILABLE` (APP-PERF-20). L'échec de
 * lecture était transformé en « aucune révocation » ET mis en cache 60 s : un
 * jeton révoqué redevenait valable pendant une panne. Rien n'est mis en cache
 * sur un échec ; la requête obtient un 503 explicite, ni succès, ni refus.
 */
export async function isRevokedByCutoff(payload: { userId: number; iat?: number; iatMs?: number }): Promise<boolean> {
  const key = sessionCutoffCacheKey(payload.userId);
  let cutoffMs = serverCacheGet<number>(key);
  if (cutoffMs == null) {
    let cutoff: Date | null;
    try {
      cutoff = await getUserSessionCutoff(payload.userId);
    } catch {
      throw new Error(SESSION_UNAVAILABLE_CODE);
    }
    cutoffMs = cutoff ? cutoff.getTime() : 0;
    serverCacheSet(key, cutoffMs, 60_000);
  }
  return cutoffMs > 0 && isIssuedBefore(payload, new Date(cutoffMs));
}

/**
 * Lot 92 (CDC 18 §20.3, SESS-07, SEC-03) : révocation globale (borne) OU
 * révocation UNITAIRE de la session `sid` dans le registre — effet immédiat,
 * sans attendre l'expiration du jeton d'accès. Lève `SESSION_UNAVAILABLE` si
 * la base ne répond pas.
 */
export async function isAccessRevoked(payload: { userId: number; sid?: string | null; iat?: number; iatMs?: number }): Promise<boolean> {
  if (await isRevokedByCutoff(payload)) return true;
  return isSessionRevoked(payload);
}

/** Le statut porté par la session autorise-t-il cette requête ? */
export function sessionStatusAllows(status: string | null | undefined, pathname: string, method: string): boolean {
  if (status === 'SUSPENDED' || status === 'DELETED') return false;
  if (isPendingDeletion(status)) return isApiAllowedWhilePendingDeletion(pathname, method);
  return true;
}

/**
 * Remplace `verifyAccessToken(token)` dans une route : `null` si le jeton est
 * invalide, révoqué, ou si le statut de la session n'autorise pas la requête.
 * Lève `SESSION_UNAVAILABLE` si la borne de révocation ne peut pas être lue
 * (à traduire en 503 par `sessionErrorToResponse`).
 */
export async function verifySessionAccessToken(
  token: string | null | undefined,
  request: Pick<NextRequest, 'method'> & { nextUrl?: { pathname: string } },
): Promise<AccessTokenPayload | null> {
  if (!token) return null;
  const payload = await verifyAccessToken(token);
  if (!payload?.userId) return null;
  if (!sessionStatusAllows(payload.status, request.nextUrl?.pathname ?? '', request.method ?? 'GET')) return null;
  if (await isAccessRevoked(payload)) return null;
  // Lot 110B : même garde MFA que `SessionService` — LÈVE `MFA_REQUIRED`
  // (403 via `sessionErrorToResponse`), jamais `null` (qui vaudrait 401 et
  // relancerait un renouvellement sans effet).
  await assertMfaSatisfied(payload, request.nextUrl?.pathname ?? '', request.method ?? 'GET');
  // Lot 54 (SEC-01) : droit actif sur le compte du jeton (lu en base, sans
  // cache). Base injoignable : `SESSION_UNAVAILABLE` remonte (503).
  if (payload.currentAccountId != null
    && !(await hasActiveAccountAccess(payload.userId, payload.currentAccountId))) return null;
  // Lot 102B : même garde que `SessionService` — version substantielle des
  // CGUV non acceptée → écriture métier refusée. LÈVE (jamais `null`, qui
  // vaudrait 401 et déconnecterait) : `sessionErrorToResponse` → 403.
  // Lot 104A : contrôle impossible → CGUV_CHECK_UNAVAILABLE (503), levé par
  // `isReacceptanceRequired` lui-même (jamais un faux « non requis »).
  const method = request.method ?? 'GET';
  if (isMutatingMethod(method) && !isApiAllowedDuringReacceptance(request.nextUrl?.pathname ?? '', method)) {
    const { isReacceptanceRequired } = await import('@/services/legal/cguv-reacceptance.service');
    if (await isReacceptanceRequired(payload.userId)) throw new Error(CGUV_REACCEPTANCE_REQUIRED_CODE);
  }
  return payload;
}
