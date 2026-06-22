import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { userActivityLog, users } from '@/db/schema';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

const VALID_ACTIVITY_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'EMAIL_CHANGE',
  'PROFILE_UPDATE',
  'PASSWORD_CHANGE',
  'SERVER_ERROR'
] as const;

type ActivityType = typeof VALID_ACTIVITY_TYPES[number];

export async function GET(request: NextRequest) {
  try {
    // Authentication check - requireAdmin will throw if not admin
    await await requireAdmin(request);

    const searchParams = request.nextUrl.searchParams;

    // Parse and validate query parameters
    const userIdParam = searchParams.get('userId');
    const activityTypeParam = searchParams.get('activityType');
    const startDateParam = searchParams.get('startDate');
    const endDateParam = searchParams.get('endDate');
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');

    // Validate userId
    let userId: number | null = null;
    if (userIdParam) {
      const parsedUserId = parseInt(userIdParam);
      if (isNaN(parsedUserId)) {
        return NextResponse.json({
          error: 'userId must be a valid integer',
          code: 'INVALID_USER_ID'
        }, { status: 400 });
      }
      userId = parsedUserId;
    }

    // Validate activityType
    let activityType: ActivityType | null = null;
    if (activityTypeParam) {
      if (!VALID_ACTIVITY_TYPES.includes(activityTypeParam as ActivityType)) {
        return NextResponse.json({
          error: `activityType must be one of: ${VALID_ACTIVITY_TYPES.join(', ')}`,
          code: 'INVALID_ACTIVITY_TYPE'
        }, { status: 400 });
      }
      activityType = activityTypeParam as ActivityType;
    }

    // Validate startDate
    let startDate: Date | null = null;
    if (startDateParam) {
      const parsed = new Date(startDateParam);
      if (isNaN(parsed.getTime())) {
        return NextResponse.json({
          error: 'startDate must be a valid ISO date string',
          code: 'INVALID_START_DATE'
        }, { status: 400 });
      }
      startDate = parsed;
    }

    // Validate endDate
    let endDate: Date | null = null;
    if (endDateParam) {
      const parsed = new Date(endDateParam);
      if (isNaN(parsed.getTime())) {
        return NextResponse.json({
          error: 'endDate must be a valid ISO date string',
          code: 'INVALID_END_DATE'
        }, { status: 400 });
      }
      endDate = parsed;
    }

    // Validate page
    let page = 1;
    if (pageParam) {
      const parsedPage = parseInt(pageParam);
      if (isNaN(parsedPage) || parsedPage < 1) {
        return NextResponse.json({
          error: 'page must be a positive integer',
          code: 'INVALID_PAGE'
        }, { status: 400 });
      }
      page = parsedPage;
    }

    // Validate limit
    let limit = 50;
    if (limitParam) {
      const parsedLimit = parseInt(limitParam);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
        return NextResponse.json({
          error: 'limit must be between 1 and 200',
          code: 'INVALID_LIMIT'
        }, { status: 400 });
      }
      limit = parsedLimit;
    }

    // Build WHERE conditions
    const conditions = [];

    if (userId !== null) {
      conditions.push(eq(userActivityLog.userId, userId));
    }

    if (activityType) {
      conditions.push(eq(userActivityLog.activityType, activityType));
    }

    if (startDate) {
      conditions.push(gte(userActivityLog.timestamp, startDate));
    }

    if (endDate) {
      conditions.push(lte(userActivityLog.timestamp, endDate));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Count total records for pagination
    const countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(userActivityLog);

    if (whereCondition) {
      countQuery.where(whereCondition);
    }

    const countResult = await countQuery;
    const total = countResult[0]?.count || 0;

    // Calculate offset
    const offset = (page - 1) * limit;

      // Build main query with LEFT JOIN
      const baseQuery = db
        .select({
          id: userActivityLog.id,
          timestamp: userActivityLog.timestamp,
          userId: userActivityLog.userId,
          userEmail: userActivityLog.userEmail,
          activityType: userActivityLog.activityType,
          ipAddress: userActivityLog.ipAddress,
          userAgent: userActivityLog.userAgent,
          details: userActivityLog.details,
          createdAt: userActivityLog.createdAt,
          user: {
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            status: users.status,
          }
        })
        .from(userActivityLog)
        .leftJoin(users, eq(userActivityLog.userId, users.id))
        .$dynamic();

      const results = await (whereCondition
        ? baseQuery.where(whereCondition)
        : baseQuery
      ).orderBy(desc(userActivityLog.timestamp)).limit(limit).offset(offset);

    // Transform results to match response format
    const data = results.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      userId: row.userId,
      userEmail: row.userEmail,
      activityType: row.activityType,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      details: row.details,
      createdAt: row.createdAt,
        user: row.userId && row.user?.id ? {
          id: row.user.id,
          firstName: row.user.firstName,
          lastName: row.user.lastName,
          status: row.user.status,
        } : null
    }));

    return NextResponse.json({
      data,
      pagination: {
        page,
        limit,
        total
      }
    }, { status: 200 });

  } catch (error: any) {
    console.error('GET /api/user-activity-log error:', error);
    
    // Handle authentication/authorization errors from requireAdmin
    if (error.message?.includes('Authentication required') || error.message?.includes('Unauthorized')) {
      return NextResponse.json({
        error: error.message,
        code: 'UNAUTHORIZED'
      }, { status: error.status || 401 });
    }

    return NextResponse.json({
      error: 'Internal server error: ' + error.message,
      code: 'INTERNAL_SERVER_ERROR'
    }, { status: 500 });
  }
}