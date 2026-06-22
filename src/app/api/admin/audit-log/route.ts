import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { adminAuditLog, users } from '@/db/schema';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    // Verify admin authentication with JWT
    const adminUser = await await requireAdmin(request);

    const searchParams = request.nextUrl.searchParams;

    // Extract query parameters
    const actionType = searchParams.get('actionType');
    const targetType = searchParams.get('targetType');
    const adminUserId = searchParams.get('adminUserId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const page = parseInt(searchParams.get('page') ?? '1');
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200);

    // Calculate offset from page and limit
    const offset = (page - 1) * limit;

    // Build conditions array for filters
    const conditions = [];

    if (actionType) {
      conditions.push(eq(adminAuditLog.actionType, actionType));
    }

    if (targetType) {
      conditions.push(eq(adminAuditLog.targetType, targetType));
    }

    if (adminUserId) {
      const parsedAdminUserId = parseInt(adminUserId);
      if (isNaN(parsedAdminUserId)) {
        return NextResponse.json({ 
          error: 'Invalid adminUserId parameter',
          code: 'INVALID_ADMIN_USER_ID' 
        }, { status: 400 });
      }
      conditions.push(eq(adminAuditLog.adminUserId, parsedAdminUserId));
    }

    if (startDate) {
      conditions.push(gte(adminAuditLog.timestamp, new Date(startDate)));
    }

    if (endDate) {
      conditions.push(lte(adminAuditLog.timestamp, new Date(endDate)));
    }

    // Build query with join to users table
    let query = db
      .select({
        id: adminAuditLog.id,
        timestamp: adminAuditLog.timestamp,
        adminUserId: adminAuditLog.adminUserId,
        adminEmail: adminAuditLog.adminEmail,
        actionType: adminAuditLog.actionType,
        targetType: adminAuditLog.targetType,
        targetId: adminAuditLog.targetId,
        details: adminAuditLog.details,
        admin: {
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        },
      })
      .from(adminAuditLog)
      .leftJoin(users, eq(adminAuditLog.adminUserId, users.id))
      .$dynamic();

      // Apply filters if any conditions exist
      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      // Execute query
      const results = await query.orderBy(desc(adminAuditLog.timestamp)).limit(limit).offset(offset);

    // Transform results to match expected format
    const auditLogs = results.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      adminUserId: row.adminUserId,
      adminEmail: row.adminEmail,
      actionType: row.actionType,
      targetType: row.targetType,
      targetId: row.targetId,
      details: row.details,
      admin: row.admin,
    }));

    return NextResponse.json(auditLogs, { status: 200 });

  } catch (error) {
    console.error('GET admin audit log error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error')
    }, { status: 500 });
  }
}