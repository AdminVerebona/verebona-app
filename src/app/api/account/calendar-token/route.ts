import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { getEntitlements } from '@/services/entitlements.service';
import { getSessionRole, requireAccountOwner } from '@/services/account/membership.service';

export async function GET(req: NextRequest) {
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

    const [account] = await db.select({
      calendarShareToken: accounts.calendarShareToken,
      calendarShareTokenActive: accounts.calendarShareTokenActive,
      calendarShareTokenCreatedAt: accounts.calendarShareTokenCreatedAt,
    }).from(accounts).where(eq(accounts.id, accountId));

    return NextResponse.json({
      token: account?.calendarShareToken ?? null,
      active: account?.calendarShareTokenActive ?? false,
      createdAt: account?.calendarShareTokenCreatedAt ?? null,
      // Lot 72D : seul le titulaire génère ou coupe le lien (Q14).
      canManage: (await getSessionRole(session)) === 'owner',
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Generate a new token (also used as regenerate)
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

    const token = randomBytes(32).toString('hex');
    const createdAt = new Date();

    await db.update(accounts).set({
      calendarShareToken: token,
      calendarShareTokenActive: true,
      calendarShareTokenCreatedAt: createdAt,
      updatedAt: createdAt,
    }).where(eq(accounts.id, accountId));

    return NextResponse.json({ token, active: true, createdAt });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
