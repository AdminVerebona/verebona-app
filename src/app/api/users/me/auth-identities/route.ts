/**
 * GET /api/users/me/auth-identities — lot 93, CDC 18 §27.1, §29 : méthodes de
 * connexion de l'utilisateur connecté (mot de passe configuré ou non, Google,
 * Apple : disponible, lié, dates, dissociation possible) et état de la
 * réauthentification (preuve fraîche, méthodes utilisables). Aucun secret.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { securitySummary } from '@/lib/auth/oauth/account-security';

export async function GET(request: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  return NextResponse.json(await securitySummary(session.userId, session.sid), { headers: { 'Cache-Control': 'no-store' } });
}
