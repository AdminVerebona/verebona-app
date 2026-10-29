/**
 * POST /api/accounts/personal — « Créer mon espace » (lot 72D, décision PO Q8).
 *
 * Une identité sans espace (invitation Duo jamais acceptée, expirée, Duo
 * résilié entre-temps, ancien membre) crée son propre compte Standard, dont
 * elle est titulaire. Essai de 7 jours SEULEMENT si l'adresse n'en a jamais
 * consommé (`trial_grants`, aucune remise à zéro). Refusé si l'utilisateur
 * est déjà titulaire d'un espace actif (409 ALREADY_HAS_OWN_SPACE) : jamais
 * de compte en double. La session est rouverte sur le nouvel espace.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import { sessionSubjectOnAccount } from '@/lib/auth/session-tokens';
import { issueSession } from '@/lib/auth/session-issuance';
import { createPersonalSpace } from '@/services/account/membership.service';

export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role, planType: users.planType, status: users.status,
        firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    if (!user) return NextResponse.json({ error: 'USER_NOT_FOUND' }, { status: 404 });

    const created = await createPersonalSpace(user);
    if (!created.ok) {
      return NextResponse.json({ error: created.error, code: created.error }, { status: 409 });
    }
    const response = NextResponse.json({ success: true, accountId: created.accountId, trialGranted: created.trialGranted });
    // Lot 92 : même session (`sid` conservé), réémise — émission unique.
    const subject = await sessionSubjectOnAccount(user, created.accountId);
    if (subject) await issueSession(request, response, { kind: 'reissue', sid: session.sid, subject });
    return response;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
