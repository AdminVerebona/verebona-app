import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';

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

    const isPremium = session.planType === 'PREMIUM' || session.planType === 'PREMIUM_DUO' || session.planType === 'PREMIUM_PRO';
    if (!isPremium) {
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
    });
  } catch (err) {
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

    const isPremium = session.planType === 'PREMIUM' || session.planType === 'PREMIUM_DUO' || session.planType === 'PREMIUM_PRO';
    if (!isPremium) {
      return NextResponse.json({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' }, { status: 403 });
    }

    const token = randomBytes(32).toString('hex');
    const createdAt = new Date();

    await db.update(accounts).set({
      calendarShareToken: token,
      calendarShareTokenActive: true,
      calendarShareTokenCreatedAt: createdAt,
      updatedAt: createdAt,
    }).where(eq(accounts.id, accountId));

    return NextResponse.json({ token, active: true, createdAt });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
