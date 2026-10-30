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
 * Notification §22 « Déconnexion de toutes les autres sessions » — lot 100D
 * (décision PO A2 du 27/10/2026, qui rétablit l'e-mail retiré au lot 79C) :
 * confirmation de sécurité OTHER_SESSIONS_REVOKED (e-mail obligatoire,
 * gabarit `notif_other_sessions_revoked` éditable au BO ; lot 101B : plus de
 * cloche — la confirmation de l'action est le message affiché à l'écran),
 *   · UNIQUEMENT ici (action globale demandée par le titulaire) — jamais pour
 *     « Déconnecter » un seul appareil, ni pour la déconnexion forcée du BO,
 *     un changement de mot de passe ou un rejeu ;
 *   · seulement si la révocation a PRIS EFFET : au moins une session du
 *     registre réellement passée de « active » à « révoquée » par cet appel,
 *     écriture validée (`revokeAllUserSessionsWithReport`). Aucune session
 *     révoquée (rien d'autre n'était connecté, double clic, registre
 *     indisponible) : aucun e-mail — jamais de confirmation trompeuse ;
 *   · une seule fois : clé d'idempotence liée à la session qui fait la
 *     demande (identifiant public, jamais le `sid`) ;
 *   · journal d'audit SESSION_REVOKED : nombre réellement révoqué et issue
 *     de la confirmation (`securityEmail`).
 * Écart CDC 18 clos : docs/exploitation/cdc18-ecarts.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, revokeAllUserSessionsWithReport } from '@/db';
import { users } from '@/db/schema';
import { requireFreshReauth, issueReauthProof } from '@/lib/auth/reauth';
import { getSessionRecord } from '@/lib/auth/session-registry';
import { confirmOtherSessionsRevoked } from '@/lib/auth/other-sessions-alert';
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

    const current = session.sid ? await getSessionRecord(session.sid).catch(() => null) : null;
    const { cutoff, registryRevoked } = await revokeAllUserSessionsWithReport(session.userId, 'USER_REVOKED_OTHERS', { keepRegistrySid: session.sid });
    // A2 : confirmation seulement si au moins une session a réellement été révoquée.
    const securityEmail = await confirmOtherSessionsRevoked({
      userId: session.userId,
      sid: session.sid ?? null,
      count: registryRevoked,
      deviceLabel: current?.deviceLabel,
      browserLabel: current?.browserLabel,
    });
    serverCacheDelete(sessionCutoffCacheKey(session.userId));
    invalidateUserReadCache(session.userId);
    // La session neuve de cet appareil doit être émise strictement APRÈS la borne.
    while (Date.now() <= cutoff.getTime()) await new Promise((r) => setTimeout(r, 1));

    const response = NextResponse.json({ success: true, revoked: registryRevoked, securityEmail: securityEmail === 'queued' });
    const issued = await issueSession(request, response, {
      kind: 'open', method: 'session_reopen', replaceCurrent: true, subject: await sessionSubjectFor(user),
    });
    await issueReauthProof(session.userId, issued.sid, proof.method, { request, expiresAt: proof.expiresAt })
      .catch(() => null);

    void logUserActivity({
      activityType: 'SESSION_REVOKED',
      userId: session.userId,
      userEmail: session.email,
      details: { scope: 'others', by: 'user', count: registryRevoked, keptSid: issued.sid, reason: 'USER_REVOKED_OTHERS', securityEmail },
      request,
    });
    return response;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

