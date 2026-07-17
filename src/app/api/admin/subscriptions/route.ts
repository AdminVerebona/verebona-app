import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accounts, users } from '@/db/schema';
import { desc, or, isNotNull, gte, eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

/**
 * GET /api/admin/subscriptions
 * Liste tous les abonnements actifs et récents
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

      const subscriptions = await db
        .select({
          id: accounts.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          planType: accounts.planType,
          stripeCustomerId: accounts.stripeCustomerId,
          stripeSubscriptionId: accounts.stripeSubscriptionId,
          premiumUntil: accounts.premiumUntil,
          createdAt: accounts.createdAt,
        })
        .from(accounts)
      .innerJoin(users, eq(accounts.ownerUserId, users.id))
      .where(
        or(
          isNotNull(accounts.stripeCustomerId),
          isNotNull(accounts.stripeSubscriptionId),
          gte(accounts.premiumUntil, thirtyDaysAgo)
        )
      )
      .orderBy(desc(accounts.premiumUntil));

      const stats = {
        total: subscriptions.length,
        standard: subscriptions.filter(s => s.planType === 'STANDARD').length,
        premium: subscriptions.filter(s => s.planType === 'PREMIUM').length,
        premium_duo: subscriptions.filter(s => s.planType === 'PREMIUM_DUO').length,
        premium_pro: subscriptions.filter(s => s.planType === 'PREMIUM_PRO').length,
        active: subscriptions.filter(s =>
          s.premiumUntil && Number(s.premiumUntil) > now
        ).length,
      };

    return NextResponse.json({
      subscriptions,
      stats,
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    console.error('[Admin Subscriptions] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch subscriptions' },
      { status: 500 }
    );
  }
}
