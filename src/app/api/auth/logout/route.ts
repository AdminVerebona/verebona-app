import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/jwt';
import { revokeToken, hashToken } from '@/db';
import { logUserActivity } from '@/lib/audit-logger';

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
  if (refreshToken) {
    try {
      const payload = await verifyToken(refreshToken);
      if (payload) {
        const tokenHash = await hashToken(refreshToken);
        const expiresAt = payload.exp
          ? new Date(payload.exp * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await revokeToken(tokenHash, payload.userId, expiresAt);
        revocation = 'revoked';
      }
    } catch {
      // Non-fatal : on efface les cookies même si la révocation échoue —
      // mais on ne l'annonce pas comme réussie.
      revocation = 'failed';
    }
  }

  void logUserActivity({
    activityType: 'AUTH_LOGOUT',
    userEmail: '',
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
