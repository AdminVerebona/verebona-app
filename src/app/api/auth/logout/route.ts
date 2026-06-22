import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/jwt';
import { revokeToken, hashToken } from '@/db';

/**
 * Logout endpoint
 * Clears the HttpOnly cookies AND révoque le refresh token en DB
 * pour bloquer toute réutilisation après déconnexion (TC-020, TC-024).
 */
export async function POST(request: NextRequest) {
  // Révoquer le refresh token en base pour invalider la session côté serveur
  // Priorité : Authorization header > cookie > body JSON
  const authHeader = request.headers.get('authorization');
  const refreshToken =
    (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null) ??
    request.cookies.get('refresh_token')?.value ??
    // Support corps JSON { refreshToken: "..." }
    await request.json().then((b: { refreshToken?: string }) => b.refreshToken).catch(() => null);

  if (refreshToken) {
    try {
      const payload = await verifyToken(refreshToken);
      if (payload) {
        const tokenHash = await hashToken(refreshToken);
        const expiresAt = payload.exp
          ? new Date(payload.exp * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await revokeToken(tokenHash, payload.userId, expiresAt);
      }
    } catch {
      // Non-fatal : on efface les cookies même si la révocation échoue
    }
  }

  const response = NextResponse.json({
    success: true,
    message: 'Logged out successfully',
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
