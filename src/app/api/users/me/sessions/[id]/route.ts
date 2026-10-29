/**
 * DELETE /api/users/me/sessions/[id] — « Déconnecter » un appareil (lot 92,
 * CDC 18 §20.3 ; SESS-07, SEC-03). Révocation UNITAIRE, effective
 * immédiatement côté serveur : le jeton d'accès de cette session est refusé
 * dès la requête suivante, son renouvellement aussi.
 *
 * `id` : identifiant public d'une session ACTIVE de l'utilisateur connecté
 * (introuvable ou d'un autre utilisateur : 404, même réponse). La session
 * courante se ferme par « Se déconnecter » (409 CURRENT_SESSION).
 * §18.3 ne range pas la déconnexion d'UN appareil parmi les actions à
 * réauthentifier (seulement « toutes les autres / toutes »).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { revokeUserSessionByPublicId, sessionPublicId } from '@/lib/auth/session-registry';
import { logUserActivity } from '@/lib/audit-logger';

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await SessionService.getSession(request);
    const id = String((await context.params).id ?? '');
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) {
      return NextResponse.json({ error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND', message: 'Cet appareil n’est plus connecté.' }, { status: 404 });
    }
    if (session.sid && sessionPublicId(session.sid) === id) {
      return NextResponse.json(
        { error: 'CURRENT_SESSION', code: 'CURRENT_SESSION', message: 'Pour cet appareil, utilisez « Se déconnecter ».' },
        { status: 409 },
      );
    }
    const revoked = await revokeUserSessionByPublicId(session.userId, id, 'USER_REVOKED');
    if (!revoked) {
      return NextResponse.json({ error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND', message: 'Cet appareil n’est plus connecté.' }, { status: 404 });
    }
    void logUserActivity({
      activityType: 'SESSION_REVOKED',
      userId: session.userId,
      userEmail: session.email,
      details: { scope: 'single', by: 'user', sid: revoked.sid, clientType: revoked.clientType, reason: 'USER_REVOKED' },
      request,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
