import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { leaveDuo, type DuoExitError } from '@/services/duo/duo-exit.service';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { issueSessionTokens, setSessionCookies } from '@/lib/auth/session-tokens';

const STATUS: Record<DuoExitError, number> = {
  DUO_NOT_FOUND: 404, NO_ACTIVE_MEMBER: 404, NOT_A_DUO_MEMBER: 404, OWNER_CANNOT_LEAVE: 409, DUO_UNPAID: 409,
};

/**
 * POST /api/duo/leave
 * Le second utilisateur quitte le Duo (AID-DUO-006). Le titulaire ne peut
 * pas quitter son propre Duo (409 OWNER_CANNOT_LEAVE).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const result = await leaveDuo(session.userId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, message: result.message }, { status: STATUS[result.error] });
    }
    // Lot 72D : l'adhésion au compte partagé est révoquée (ancien jeton
    // refusé dès la requête suivante) ; la session est rouverte tout de suite
    // sur un autre espace de l'utilisateur, ou sans espace (écran dédié).
    // Aucune donnée du Duo n'est touchée, rien n'est créé.
    const response = NextResponse.json({ success: true, status: result.status, cancelledRequests: result.cancelledRequests });
    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role, planType: users.planType, status: users.status })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    if (user) setSessionCookies(response, await issueSessionTokens(user));
    return response;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
