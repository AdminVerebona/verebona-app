import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exportGenerations, users, assets, accounts } from '@/db/schema';
import { eq, and, desc, count, sql, gte, lte, like, or, inArray } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get('page') ?? '1');
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200);
    const offset = (page - 1) * limit;
    const status = searchParams.get('status');
    const exportType = searchParams.get('exportType');
    const search = searchParams.get('search');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const statsOnly = searchParams.get('statsOnly') === 'true';

    const conditions: any[] = [];

    if (status && status !== 'all') {
      conditions.push(eq(exportGenerations.status, status));
    }
    if (exportType && exportType !== 'all') {
      conditions.push(eq(exportGenerations.exportType, exportType));
    }
    if (startDate) {
      conditions.push(gte(exportGenerations.createdAt, new Date(startDate)));
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      conditions.push(lte(exportGenerations.createdAt, end));
    }

    // Stats
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalResult,
      statusCountsResult,
      typeCountsResult,
      last30DaysResult,
    ] = await Promise.all([
      db.select({ count: count() }).from(exportGenerations),
      db.select({ status: exportGenerations.status, count: count() })
        .from(exportGenerations)
        .groupBy(exportGenerations.status),
      db.select({ exportType: exportGenerations.exportType, count: count() })
        .from(exportGenerations)
        .groupBy(exportGenerations.exportType),
      db.select({ count: count() })
        .from(exportGenerations)
        .where(gte(exportGenerations.createdAt, thirtyDaysAgo)),
    ]);

    const stats = {
      total: totalResult[0].count,
      last30Days: last30DaysResult[0].count,
      byStatus: Object.fromEntries(statusCountsResult.map(r => [r.status, r.count])),
      byType: Object.fromEntries(typeCountsResult.map(r => [r.exportType, r.count])),
    };

    if (statsOnly) {
      return NextResponse.json({ stats });
    }

    // List with joins
    let baseQuery = db
      .select({
        id: exportGenerations.id,
        publicId: exportGenerations.publicId,
        exportType: exportGenerations.exportType,
        variant: exportGenerations.variant,
        status: exportGenerations.status,
        requestedOutputs: exportGenerations.requestedOutputs,
        errorPayload: exportGenerations.errorPayload,
        generationAttemptCount: exportGenerations.generationAttemptCount,
        createdAt: exportGenerations.createdAt,
        completedAt: exportGenerations.completedAt,
        generationStartedAt: exportGenerations.generationStartedAt,
        asset: {
          id: assets.id,
          name: assets.name,
          category: assets.category,
          publicId: assets.publicId,
        },
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        },
        account: {
          id: accounts.id,
          name: accounts.name,
        },
      })
      .from(exportGenerations)
      .leftJoin(assets, eq(exportGenerations.assetId, assets.id))
      .leftJoin(users, eq(exportGenerations.userId, users.id))
      .leftJoin(accounts, eq(exportGenerations.accountId, accounts.id))
      .$dynamic();

    if (conditions.length > 0) {
      baseQuery = baseQuery.where(and(...conditions));
    }

    // Search across user email, asset name
    if (search) {
      const searchConditions = or(
        like(users.email, `%${search}%`),
        like(users.firstName, `%${search}%`),
        like(users.lastName, `%${search}%`),
        like(assets.name, `%${search}%`),
      );
      if (conditions.length > 0) {
        baseQuery = baseQuery.where(and(and(...conditions), searchConditions));
      } else {
        baseQuery = baseQuery.where(searchConditions!);
      }
    }

    const rows = await baseQuery
      .orderBy(desc(exportGenerations.createdAt))
      .limit(limit)
      .offset(offset);

    // Count for pagination
    const countQuery = db
      .select({ count: count() })
      .from(exportGenerations)
      .leftJoin(assets, eq(exportGenerations.assetId, assets.id))
      .leftJoin(users, eq(exportGenerations.userId, users.id))
      .$dynamic();

    const allConditions = [...conditions];
    if (search) {
      allConditions.push(
        or(
          like(users.email, `%${search}%`),
          like(users.firstName, `%${search}%`),
          like(users.lastName, `%${search}%`),
          like(assets.name, `%${search}%`),
        )!
      );
    }
    const countResult = allConditions.length > 0
      ? await countQuery.where(and(...allConditions))
      : await countQuery;

    const total = countResult[0].count;

    return NextResponse.json({
      data: rows,
      stats,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });

  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (['INVALID_TOKEN', 'AUTH_REQUIRED', 'INSUFFICIENT_PERMISSIONS', 'ACCOUNT_SUSPENDED'].includes(message)) {
      const { SessionService } = await import('@/lib/session-service');
      return SessionService.handleSessionError(error);
    }
    console.error('GET admin exports error:', message);
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
