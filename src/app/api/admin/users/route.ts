import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, assets, accountMemberships, accounts } from '@/db/schema';
import { eq, like, and, or, desc, count, lt, sql } from 'drizzle-orm';
import { parsePaginationParams, getCursorId, encodeCursor } from '@/lib/pagination';
import { requireAdmin } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const searchParams = request.nextUrl.searchParams;
    const { limit, cursor } = parsePaginationParams(searchParams);
    const search = searchParams.get('search');
    const status = searchParams.get('status');
    const role = searchParams.get('role');

    const conditions = [];
    const cursorId = getCursorId(cursor);
    if (cursorId !== null) {
      conditions.push(lt(users.id, cursorId));
    }

    if (search) {
      const searchTerm = `%${search}%`;
      conditions.push(
        or(
          like(users.email, searchTerm),
          like(users.firstName, searchTerm),
          like(users.lastName, searchTerm)
        )
      );
    }

    if (status && status !== 'all') {
      conditions.push(eq(users.status, status as any));
    }

    if (role && role !== 'all') {
      conditions.push(eq(users.role, role as any));
    }

    const usersList = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        username: users.username,
        company: users.company,
        // Account plan is the source of truth; fall back to user's plan_type
        planType: sql<string>`COALESCE(min(${accounts.planType}), ${users.planType})`,
        accountId: sql<number | null>`min(${accounts.id})`,
        accountName: sql<string | null>`min(${accounts.name})`,
        isActive: users.isActive,
        locale: users.locale,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        assetCount: sql<number>`count(distinct ${assets.id})`.mapWith(Number),
      })
      .from(users)
      .leftJoin(accountMemberships, and(
        eq(accountMemberships.userId, users.id),
        eq(accountMemberships.role, 'owner')
      ))
      .leftJoin(accounts, eq(accounts.id, accountMemberships.accountId))
      .leftJoin(assets, eq(assets.accountId, accountMemberships.accountId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(users.id)
      .orderBy(desc(users.id))
      .limit(limit + 1);

    const hasMore = usersList.length > limit;
    const data = usersList.slice(0, limit);
    const lastItem = data[data.length - 1];

    const normalizePlan = (p: string | null) => {
      if (!p) return 'STANDARD';
      return p.toUpperCase();
    };

    return NextResponse.json({
      data: data.map(u => ({ ...u, planType: normalizePlan(u.planType) })),
      hasMore,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem.id) : null,
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET error:', error);
    return SessionService.handleSessionError(error);
  }
}
