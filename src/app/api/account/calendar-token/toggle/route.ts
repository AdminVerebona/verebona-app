import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getEntitlements } from '@/services/entitlements.service';
import { requireAccountOwner } from '@/services/account/membership.service';

export async function PATCH(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    // Lot 72D : droits du COMPTE courant (entitlements), plus le `planType`
    // de l'utilisateur copié dans le jeton.
    if (!(await getEntitlements(accountId)).premiumFeatures) {
      return NextResponse.json({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' }, { status: 403 });
    }
    // Jeton de partage du calendrier : réservé au titulaire (matrice Q14).
    const notOwner = await requireAccountOwner(session);
    if (notOwner) return notOwner;

    const body = await req.json();
    const { active } = body;
    if (typeof active !== 'boolean') {
      return NextResponse.json({ error: 'active must be boolean' }, { status: 400 });
    }

    await db.update(accounts).set({
      calendarShareTokenActive: active,
      updatedAt: new Date(),
    }).where(eq(accounts.id, accountId));

    return NextResponse.json({ active });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
