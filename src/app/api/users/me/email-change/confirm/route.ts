/**
 * POST /api/users/me/email-change/confirm — { token } : validation du lien
 * reçu à la NOUVELLE adresse (lot 96A, CDC 18 §11.3, EMAIL-05/06/07 ; Q8).
 *
 * Session du MÊME utilisateur exigée (la page « Confirmer ma nouvelle
 * adresse » renvoie à la connexion sinon) ; le lien est la preuve du contrôle
 * de la nouvelle boîte, la réauthentification a été faite à la demande.
 * Après la bascule atomique :
 *   · toutes les AUTRES sessions sont révoquées — y compris celles ouvertes
 *     avant le registre (borne globale ; mécanisme 92 « autres appareils ») ;
 *   · CETTE session continue : jetons réémis (l'adresse figure dans le JWT),
 *     même espace courant ;
 *   · preuves de réauthentification retirées (Q7) ;
 *   · notification de sécurité aux deux adresses ; client Stripe existant
 *     mis à jour (jamais créé) ; journal PRIMARY_EMAIL_CHANGED.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, revokeAllUserSessions } from '@/db';
import { users } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import { invalidateReauthProofs } from '@/lib/auth/reauth';
import { issueSession } from '@/lib/auth/session-issuance';
import { sessionCutoffCacheKey, sessionSubjectFor, sessionSubjectOnAccount } from '@/lib/auth/session-tokens';
import { invalidateUserReadCache, serverCacheDelete } from '@/lib/server-cache';
import { logUserActivity } from '@/lib/audit-logger';
import { confirmEmailChange, notifyEmailChanged } from '@/services/auth/email-change.service';

const STATUS = { INVALID_LINK: 400, LINK_EXPIRED: 410, LINK_USED: 409, WRONG_ACCOUNT: 403, ADDRESS_UNAVAILABLE: 409 } as const;

export async function POST(request: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  try {
    const result = await confirmEmailChange({ userId: session.userId, token: body.token });
    if (!result.ok) {
      void logUserActivity({ activityType: 'PRIMARY_EMAIL_CHANGE_REFUSED', userId: session.userId, userEmail: session.email, details: { code: result.code }, request });
      return NextResponse.json({ error: result.code, code: result.code, message: result.message }, { status: STATUS[result.code] });
    }

    // Toutes les autres sessions, anciennes comprises ; la ligne de CETTE session reste au registre.
    const cutoff = await revokeAllUserSessions(session.userId, 'EMAIL_CHANGED', { keepRegistrySid: session.sid });
    serverCacheDelete(sessionCutoffCacheKey(session.userId));
    invalidateUserReadCache(session.userId);
    await invalidateReauthProofs(session.userId, { reason: 'primary_email_changed' });
    // La session neuve de cet appareil doit être émise strictement APRÈS la borne.
    while (Date.now() <= cutoff.getTime()) await new Promise((r) => setTimeout(r, 1));

    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role, planType: users.planType, status: users.status })
      .from(users).where(eq(users.id, session.userId)).limit(1);
    if (!user) return NextResponse.json({ error: 'USER_NOT_FOUND' }, { status: 404 });
    const subject = (session.currentAccountId ? await sessionSubjectOnAccount(user, session.currentAccountId) : null)
      ?? await sessionSubjectFor(user);

    const response = NextResponse.json({
      success: true,
      email: result.newEmail,
      message: 'Votre nouvelle adresse est confirmée. Elle sert désormais à vous connecter et à recevoir nos messages. Vos autres appareils ont été déconnectés.',
    });
    await issueSession(request, response, { kind: 'open', method: 'session_reopen', replaceCurrent: true, subject });

    const after = await notifyEmailChanged({ userId: session.userId, oldEmail: result.oldEmail, newEmail: result.newEmail });
    void logUserActivity({
      activityType: 'PRIMARY_EMAIL_CHANGED',
      userId: session.userId,
      userEmail: result.newEmail,
      details: { sessionsRevoked: true, notifiedCount: after.notified.length, stripeUpdated: after.stripe.updated, stripeFailed: after.stripe.failed },
      request,
    });
    return response;
  } catch (error) {
    console.error('[email-change] confirmation :', (error as Error)?.message ?? error);
    return NextResponse.json({ error: 'EMAIL_CHANGE_CONFIRM_FAILED', code: 'EMAIL_CHANGE_CONFIRM_FAILED', message: 'La confirmation n’a pas pu être enregistrée. Réessayez.' }, { status: 500 });
  }
}
