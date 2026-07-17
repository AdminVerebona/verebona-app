import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { referralLinks, referralEvents, accounts, users } from '@/db/schema';
import { eq, desc, count, sql } from 'drizzle-orm';

/**
 * GET /api/admin/referrals
 * Liste tous les codes de parrainage avec leurs stats.
 * Admin only.
 */
export async function GET(request: NextRequest) {
  try {
    await SessionService.requireAdmin(request);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = 50;
    const offset = (page - 1) * limit;

    // Stats globales
    const [globalStats] = await db
      .select({
        totalLinks: count(referralLinks.id),
      })
      .from(referralLinks);

    const [eventStats] = await db
      .select({
        totalUsed: count(referralEvents.id),
        totalValidated: sql<number>`count(*) filter (where ${referralEvents.status} = 'reward_granted')`,
        totalCreditsGranted: sql<number>`coalesce(sum(${referralEvents.rewardCredits}) filter (where ${referralEvents.status} = 'reward_granted'), 0)`,
      })
      .from(referralEvents);

    // Liste paginée des codes avec infos parrain
    const links = await db
      .select({
        id: referralLinks.id,
        code: referralLinks.code,
        isActive: referralLinks.isActive,
        accountId: referralLinks.accountId,
        createdAt: referralLinks.createdAt,
        ownerUserId: accounts.ownerUserId,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(referralLinks)
      .leftJoin(accounts, eq(accounts.id, referralLinks.accountId))
      .leftJoin(users, eq(users.id, accounts.ownerUserId))
      .orderBy(desc(referralLinks.createdAt))
      .limit(limit)
      .offset(offset);

    // Pour chaque lien, récupérer le nombre d'usages et de validations
    const linkIds = links.map((l) => l.id);

    const eventCounts = linkIds.length > 0
      ? await db
          .select({
            referralLinkId: referralEvents.referralLinkId,
            usedCount: count(),
            validatedCount: sql<number>`count(*) filter (where ${referralEvents.status} = 'reward_granted')`,
          })
          .from(referralEvents)
          .where(sql`${referralEvents.referralLinkId} = any(${sql`array[${sql.raw(linkIds.join(','))}]`})`)
          .groupBy(referralEvents.referralLinkId)
      : [];

    const eventCountMap = new Map(eventCounts.map((e) => [e.referralLinkId, e]));

    const enrichedLinks = links.map((link) => {
      const stats = eventCountMap.get(link.id);
      return {
        ...link,
        usedCount: stats?.usedCount ?? 0,
        validatedCount: stats?.validatedCount ?? 0,
      };
    });

    return NextResponse.json({
      globalStats: {
        totalLinks: globalStats?.totalLinks ?? 0,
        totalUsed: eventStats?.totalUsed ?? 0,
        totalValidated: eventStats?.totalValidated ?? 0,
        totalCreditsGranted: eventStats?.totalCreditsGranted ?? 0,
      },
      links: enrichedLinks,
      pagination: {
        page,
        limit,
        hasMore: links.length === limit,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) {
      return SessionService.handleSessionError(error);
    }
    if (error instanceof Error && error.message.includes('FORBIDDEN')) {
      return NextResponse.json({ code: 'FORBIDDEN' }, { status: 403 });
    }
    console.error('[Admin Referrals GET]', error);
    return NextResponse.json({ code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
