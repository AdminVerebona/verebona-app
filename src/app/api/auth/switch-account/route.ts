/**
 * POST /api/auth/switch-account { accountId } — changement d'espace (lot 72D,
 * ticket P0 « Premium Duo — compte partagé » §3-4, décisions PO Q6/Q7).
 *
 * Un utilisateur peut appartenir à plusieurs comptes (son espace personnel et
 * un Premium Duo, par exemple). Le changement :
 *   · exige une adhésion ACTIVE au compte demandé, relue en base, et un compte
 *     non suspendu — l'identifiant fourni par le client n'accorde jamais de
 *     droit (403 ACCOUNT_NOT_ACCESSIBLE, même réponse qu'il existe ou non) ;
 *   · réémet les cookies de session sur ce compte (web et application mobile :
 *     même WebView, mêmes cookies HttpOnly) ;
 *   · mémorise ce choix (`last_selected_at`) : la prochaine connexion rouvre
 *     ce même espace s'il est encore accessible ;
 *   · invalide les lectures mises en cache pour l'utilisateur.
 * Aucune donnée, aucun droit ni quota n'est mélangé : chaque requête reste
 * filtrée sur le compte de la session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import { sessionSubjectOnAccount } from '@/lib/auth/session-tokens';
import { issueSession } from '@/lib/auth/session-issuance';
import { markAccountSelected } from '@/services/account/membership.service';
import { invalidateUserReadCache } from '@/lib/server-cache';
import { logUserActivity } from '@/lib/audit-logger';

export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const body = await request.json().catch(() => ({}));
    const accountId = Number((body as { accountId?: unknown }).accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return NextResponse.json({ error: 'INVALID_ACCOUNT', code: 'INVALID_ACCOUNT' }, { status: 400 });
    }

    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role, planType: users.planType, status: users.status })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const subject = user ? await sessionSubjectOnAccount(user, accountId) : null;
    if (!subject) {
      console.warn(JSON.stringify({ event: 'security.switch_account_refused', userId: session.userId, accountId }));
      return NextResponse.json(
        { error: 'ACCOUNT_NOT_ACCESSIBLE', code: 'ACCOUNT_NOT_ACCESSIBLE', message: 'Cet espace n’est pas accessible.' },
        { status: 403 },
      );
    }

    await markAccountSelected(session.userId, accountId);
    invalidateUserReadCache(session.userId);
    void logUserActivity({
      activityType: 'ACCOUNT_SWITCHED',
      userId: session.userId,
      userEmail: session.email,
      details: { from: session.currentAccountId ?? null, to: accountId },
      request,
    });

    const response = NextResponse.json({ success: true, accountId });
    // Lot 92 : même session (`sid` conservé), réémise sur l'espace choisi — émission unique.
    await issueSession(request, response, { kind: 'reissue', sid: session.sid, subject });
    return response;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
