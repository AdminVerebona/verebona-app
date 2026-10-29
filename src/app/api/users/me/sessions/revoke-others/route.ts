/**
 * POST /api/users/me/sessions/revoke-others — « Déconnecter tous les autres
 * appareils » (lot 92, CDC 18 §20.3, §18.3 ; SESS-08). Exige une preuve de
 * réauthentification fraîche de CETTE session (réutilisable, non consommée).
 *
 * Toutes les autres sessions sont coupées, y compris celles ouvertes avant le
 * registre et pas encore inscrites (borne de révocation globale, lot 37) ;
 * cet appareil reçoit aussitôt une session neuve (même appareil, la preuve
 * de réauthentification y est reportée sans être prolongée).
 *
 * Notification §22 « Déconnexion de toutes les autres sessions » : aucun type
 * existant ne la porte (l'e-mail SECURITY_SESSIONS_REVOKED a été retiré au
 * lot 79C par décision PO) — journal interne seul (SESSION_REVOKED), écart
 * documenté dans docs/exploitation/cdc18-ecarts.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, revokeAllUserSessions } from '@/db';
import { users } from '@/db/schema';
import { requireFreshReauth, issueReauthProof } from '@/lib/auth/reauth';
import { listUserSessions } from '@/lib/auth/session-registry';
import { issueSession } from '@/lib/auth/session-issuance';
import { sessionSubjectFor, sessionCutoffCacheKey } from '@/lib/auth/session-tokens';
import { invalidateUserReadCache, serverCacheDelete } from '@/lib/server-cache';
import { logUserActivity } from '@/lib/audit-logger';
import { SessionService } from '@/lib/session-service';

export async function POST(request: NextRequest) {
  const check = await requireFreshReauth(request, { action: 'revoke_other_sessions' });
  if (!check.ok) return check.response;
  const { session, proof } = check;
  try {
    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role, planType: users.planType, status: users.status })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    if (!user) return NextResponse.json({ error: 'USER_NOT_FOUND' }, { status: 404 });

    const others = (await listUserSessions(session.userId, session.sid)).filter((s) => !s.current).length;
    const cutoff = await revokeAllUserSessions(session.userId, 'USER_REVOKED_OTHERS', { keepRegistrySid: session.sid });
    serverCacheDelete(sessionCutoffCacheKey(session.userId));
    invalidateUserReadCache(session.userId);
    // La session neuve de cet appareil doit être émise strictement APRÈS la borne.
    while (Date.now() <= cutoff.getTime()) await new Promise((r) => setTimeout(r, 1));

    const response = NextResponse.json({ success: true, revoked: others });
    const issued = await issueSession(request, response, {
      kind: 'open', method: 'session_reopen', replaceCurrent: true, subject: await sessionSubjectFor(user),
    });
    await issueReauthProof(session.userId, issued.sid, proof.method, { request, expiresAt: proof.expiresAt })
      .catch(() => null);

    void logUserActivity({
      activityType: 'SESSION_REVOKED',
      userId: session.userId,
      userEmail: session.email,
      details: { scope: 'others', by: 'user', count: others, keptSid: issued.sid, reason: 'USER_REVOKED_OTHERS' },
      request,
    });
    return response;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
