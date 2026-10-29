/**
 * POST /api/users/me/security/reauth — réauthentification du bloc Sécurité
 * (lot 92, CDC 18 §18, §29 ; REAUTH-01/02/06 ; décision PO Q7).
 *
 * Corps : `{ method?: 'password', password }`. Méthode vérifiée côté serveur
 * (`lib/auth/reauth.ts`, limiteur partagé du lot 53A), puis preuve émise par
 * le serveur pour CETTE session, valable 5 minutes. Réponse : échéance de la
 * preuve, rien d'autre (aucun jeton). Les méthodes à redirection (Google /
 * Apple, sous-lot 93) ne passent pas par ici : leur retour appelle
 * `issueReauthProof`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getReauthMethod, issueReauthProof, logReauthFailure, ReauthError } from '@/lib/auth/reauth';

export async function POST(request: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  if (!session.sid) {
    return NextResponse.json(
      { error: 'SESSION_REVOKED', code: 'SESSION_REVOKED', message: 'Votre session doit être renouvelée : reconnectez-vous.' },
      { status: 401 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const methodId = typeof body.method === 'string' && body.method ? body.method : 'password';
  const method = getReauthMethod(methodId);
  if (!method || method.kind !== 'password' || !method.verify || !(await method.isAvailableFor(session.userId))) {
    return NextResponse.json(
      { error: 'REAUTH_METHOD_UNAVAILABLE', code: 'REAUTH_METHOD_UNAVAILABLE', message: 'Cette méthode de confirmation n’est pas disponible pour votre compte.' },
      { status: 400 },
    );
  }
  const result = await method.verify({ request, userId: session.userId, input: body });
  if (result.status === 'blocked') {
    logReauthFailure(request, session.userId, methodId, 'RATE_LIMITED');
    return result.response;
  }
  if (result.status === 'failed') {
    logReauthFailure(request, session.userId, methodId, result.code);
    return NextResponse.json({ error: result.code, code: result.code, message: result.message }, { status: result.httpStatus });
  }
  try {
    const { expiresAt } = await issueReauthProof(session.userId, session.sid, methodId, { request });
    return NextResponse.json({ success: true, freshUntil: expiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ReauthError) {
      return NextResponse.json(
        { error: 'SESSION_REVOKED', code: 'SESSION_REVOKED', message: 'Votre session a été fermée : reconnectez-vous.' },
        { status: 401 },
      );
    }
    console.error('[security/reauth] émission de la preuve impossible :', (error as Error)?.message ?? error);
    return NextResponse.json({ error: 'SERVICE_UNAVAILABLE', code: 'SERVICE_UNAVAILABLE', message: 'Service momentanément indisponible. Réessayez.' }, { status: 503 });
  }
}
