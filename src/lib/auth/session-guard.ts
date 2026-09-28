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
import { serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from './session-cutoff';
import { isApiAllowedWhilePendingDeletion, isPendingDeletion } from './account-closure';

/** Jeton émis avant la révocation globale de son utilisateur ? (borne en cache 60 s) */
export async function isRevokedByCutoff(payload: { userId: number; iat?: number; iatMs?: number }): Promise<boolean> {
  const key = sessionCutoffCacheKey(payload.userId);
  let cutoffMs = serverCacheGet<number>(key);
  if (cutoffMs == null) {
    const cutoff = await getUserSessionCutoff(payload.userId).catch(() => null);
    cutoffMs = cutoff ? cutoff.getTime() : 0;
    serverCacheSet(key, cutoffMs, 60_000);
  }
  return cutoffMs > 0 && isIssuedBefore(payload, new Date(cutoffMs));
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
 */
export async function verifySessionAccessToken(
  token: string | null | undefined,
  request: Pick<NextRequest, 'method'> & { nextUrl?: { pathname: string } },
): Promise<AccessTokenPayload | null> {
  if (!token) return null;
  const payload = await verifyAccessToken(token);
  if (!payload?.userId) return null;
  if (!sessionStatusAllows(payload.status, request.nextUrl?.pathname ?? '', request.method ?? 'GET')) return null;
  if (await isRevokedByCutoff(payload)) return null;
  return payload;
}
