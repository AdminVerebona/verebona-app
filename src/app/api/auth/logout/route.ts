import { NextRequest, NextResponse } from 'next/server';
import { verifyRefreshToken } from '@/lib/jwt';
import { revokeToken, hashToken } from '@/db';
import { logUserActivity } from '@/lib/audit-logger';
import { endSession } from '@/lib/auth/session-registry';
import { invalidateReauthProofs } from '@/lib/auth/reauth';

/**
 * Logout endpoint
 * Clears the HttpOnly cookies AND révoque le refresh token en DB
 * pour bloquer toute réutilisation après déconnexion (TC-020, TC-024).
 */
export async function POST(request: NextRequest) {
  // Révoquer le refresh token en base pour invalider la session côté serveur
  // Priorité : Authorization header > cookie > body JSON
  // CDC §7.2 / §8 : le jeton est lu uniquement depuis le cookie HttpOnly.
  // La revocation cote serveur est indispensable : effacer le cookie ne suffit pas.
  const refreshToken = request.cookies.get('refresh_token')?.value;

  // Résultat RÉEL de la révocation, rendu au client (APP-PERF-21) : effacer
  // les cookies ne révoque pas la session. `none` : aucun jeton à révoquer.
  let revocation: 'revoked' | 'none' | 'failed' = 'none';
  let loggedOut: { userId: number; sid: string } | null = null;
  if (refreshToken) {
    try {
      // Jeton de RENOUVELLEMENT (lot 37, C1) : un jeton d'accès glissé dans
      // ce cookie n'est pas révoqué à sa place.
      const payload = await verifyRefreshToken(refreshToken);
      if (payload) {
        const tokenHash = await hashToken(refreshToken);
        const expiresAt = payload.exp
          ? new Date(payload.exp * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await revokeToken(tokenHash, payload.userId, expiresAt, 'logout');
        revocation = 'revoked';
        // Lot 92 : la session quitte le registre (« Appareils connectés »),
        // crochets `onSessionRevoked` (scope 'logout' : jeton push de CET
        // appareil, CDC 12 AUTH-10). Les autres appareils sont inchangés.
        if (typeof payload.sid === 'string' && payload.sid) {
          await endSession(payload.userId, payload.sid, 'LOGOUT');
          // Lot 96A (CDC 18 Q7) : la preuve de réauthentification de CETTE
          // session disparaît avec elle — y compris pour une session ouverte
          // avant le registre (aucune ligne à révoquer).
          await invalidateReauthProofs(payload.userId, { sid: payload.sid, reason: 'logout' });
          loggedOut = { userId: payload.userId, sid: payload.sid };
        }
      }
    } catch {
      // Non-fatal : on efface les cookies même si la révocation échoue —
      // mais on ne l'annonce pas comme réussie.
      revocation = 'failed';
    }
  }

  void logUserActivity({
    activityType: 'AUTH_LOGOUT',
    userId: loggedOut?.userId ?? null,
    userEmail: '',
    ...(loggedOut ? { details: { sid: loggedOut.sid } } : {}),
    request,
  });

  const response = NextResponse.json({
    success: true,
    message: 'Logged out successfully',
    revocation,
  });

  // Clear access token cookie
  response.cookies.set('access_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });

  // Clear refresh token cookie
  response.cookies.set('refresh_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });

  return response;
}
