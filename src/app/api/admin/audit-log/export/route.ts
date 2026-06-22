import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { userActivityLog, adminAuditLog, users } from '@/db/schema';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

const MAX_ROWS = 10000;
const UTF8_BOM = '\uFEFF';

// Valid enum values for validation
const VALID_ACTIVITY_TYPES = ['LOGIN_SUCCESS', 'LOGIN_FAILED', 'EMAIL_CHANGE', 'PROFILE_UPDATE', 'PASSWORD_CHANGE', 'SERVER_ERROR'];
const VALID_ACTION_TYPES = [
  'USER_CREATE', 'USER_UPDATE', 'USER_SUSPEND', 'USER_REACTIVATE', 'USER_DELETE',
  'ASSET_VIEW', 'ASSET_UPDATE', 'ASSET_DELETE',
  'FILE_VIEW', 'FILE_DELETE',
  'EMAIL_TEMPLATE_UPDATE',
  'ASSET_TYPE_CREATE', 'ASSET_TYPE_UPDATE', 'ASSET_TYPE_DELETE',
  'SUBCATEGORY_CREATE', 'SUBCATEGORY_UPDATE', 'SUBCATEGORY_DELETE'
];

// Helper function to escape CSV values
function escapeCSV(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }
  
  let stringValue = String(value);
  
  // Handle objects/arrays by converting to JSON
  if (typeof value === 'object') {
    stringValue = JSON.stringify(value);
  }
  
  // Escape double quotes by doubling them
  stringValue = stringValue.replace(/"/g, '""');
  
  // Wrap in quotes if contains comma, quote, or newline
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n') || stringValue.includes('\r')) {
    return `"${stringValue}"`;
  }
  
  return stringValue;
}

// Validate ISO date string
function isValidISODate(dateString: string): boolean {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime()) && dateString === date.toISOString();
}

export async function GET(request: NextRequest) {
  try {
    // Admin authentication check
    const admin = await await requireAdmin(request);
    if (!admin) {
      return NextResponse.json({ 
        error: 'Admin access required',
        code: 'ADMIN_ACCESS_REQUIRED' 
      }, { status: 403 });
    }

    const searchParams = request.nextUrl.searchParams;
    
    // Extract and validate query parameters
    const userIdParam = searchParams.get('userId');
    const activityType = searchParams.get('activityType');
    const actionType = searchParams.get('actionType');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    // Validate userId if provided
    let userId: number | undefined;
    if (userIdParam) {
      userId = parseInt(userIdParam);
      if (isNaN(userId)) {
        return NextResponse.json({ 
          error: 'Invalid userId parameter',
          code: 'INVALID_USER_ID' 
        }, { status: 400 });
      }
    }

    // Validate activityType if provided
    if (activityType && !VALID_ACTIVITY_TYPES.includes(activityType)) {
      return NextResponse.json({ 
        error: `Invalid activityType. Must be one of: ${VALID_ACTIVITY_TYPES.join(', ')}`,
        code: 'INVALID_ACTIVITY_TYPE' 
      }, { status: 400 });
    }

    // Validate actionType if provided
    if (actionType && !VALID_ACTION_TYPES.includes(actionType)) {
      return NextResponse.json({ 
        error: `Invalid actionType. Must be one of: ${VALID_ACTION_TYPES.join(', ')}`,
        code: 'INVALID_ACTION_TYPE' 
      }, { status: 400 });
    }

    // Validate date parameters
    if (startDate && !isValidISODate(startDate)) {
      return NextResponse.json({ 
        error: 'Invalid startDate format. Must be ISO 8601 format',
        code: 'INVALID_START_DATE' 
      }, { status: 400 });
    }

    if (endDate && !isValidISODate(endDate)) {
      return NextResponse.json({ 
        error: 'Invalid endDate format. Must be ISO 8601 format',
        code: 'INVALID_END_DATE' 
      }, { status: 400 });
    }

    // Build conditions for user activity log query
    const userActivityConditions = [];
    if (userId) {
      userActivityConditions.push(eq(userActivityLog.userId, userId));
    }
    if (activityType) {
      userActivityConditions.push(eq(userActivityLog.activityType, activityType as any));
    }
    if (startDate) {
      userActivityConditions.push(gte(userActivityLog.timestamp, new Date(startDate)));
    }
    if (endDate) {
      userActivityConditions.push(lte(userActivityLog.timestamp, new Date(endDate)));
    }

      // Fetch user activity logs
      let userActivityQuery = db.select({
        timestamp: userActivityLog.timestamp,
        userEmail: userActivityLog.userEmail,
        activityType: userActivityLog.activityType,
        details: userActivityLog.details,
        ipAddress: userActivityLog.ipAddress,
        userAgent: userActivityLog.userAgent,
        logType: userActivityLog.id
      })
      .from(userActivityLog)
      .$dynamic();

      if (userActivityConditions.length > 0) {
      userActivityQuery = userActivityQuery.where(and(...userActivityConditions));
    }

    const userActivityResults = await userActivityQuery
      .orderBy(desc(userActivityLog.timestamp))
      .limit(MAX_ROWS);

    // Build conditions for admin audit log query
    const adminAuditConditions = [];
    if (actionType) {
      adminAuditConditions.push(eq(adminAuditLog.actionType, actionType as any));
    }
    if (startDate) {
      adminAuditConditions.push(gte(adminAuditLog.timestamp, new Date(startDate)));
    }
    if (endDate) {
      adminAuditConditions.push(lte(adminAuditLog.timestamp, new Date(endDate)));
    }

      // Fetch admin audit logs with target user info
      let adminAuditQuery = db.select({
        timestamp: adminAuditLog.timestamp,
        targetUserId: adminAuditLog.targetId,
        actionType: adminAuditLog.actionType,
        details: adminAuditLog.details,
        adminEmail: adminAuditLog.adminEmail,
        targetType: adminAuditLog.targetType,
        userEmail: users.email
      })
      .from(adminAuditLog)
      .leftJoin(
        users,
        and(
          eq(adminAuditLog.targetType, 'user'),
          eq(adminAuditLog.targetId, users.id)
        )
      )
      .$dynamic();

      if (adminAuditConditions.length > 0) {
      adminAuditQuery = adminAuditQuery.where(and(...adminAuditConditions));
    }

    const adminAuditResults = await adminAuditQuery
      .orderBy(desc(adminAuditLog.timestamp))
      .limit(MAX_ROWS);

    // Transform and combine results
    const combinedLogs = [
      ...userActivityResults.map(row => ({
        timestamp: row.timestamp,
        user_email: row.userEmail,
        activity_type: row.activityType,
        action_type: '',
        details: row.details,
        admin_email: '',
        ip_address: row.ipAddress,
        user_agent: row.userAgent,
        log_type: 'USER_ACTIVITY'
      })),
      ...adminAuditResults.map(row => ({
        timestamp: row.timestamp,
        user_email: row.userEmail || '',
        activity_type: '',
        action_type: row.actionType,
        details: row.details,
        admin_email: row.adminEmail,
        ip_address: '',
        user_agent: '',
        log_type: 'ADMIN_ACTION'
      }))
    ];

    // Sort combined results by timestamp descending
    combinedLogs.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeB - timeA;
    });

    // Limit to MAX_ROWS after combining
    const limitedLogs = combinedLogs.slice(0, MAX_ROWS);
    const isTruncated = combinedLogs.length > MAX_ROWS;

    // Generate CSV content
    const headers = [
      'timestamp',
      'user_email',
      'activity_type',
      'action_type',
      'details',
      'admin_email',
      'ip_address',
      'user_agent',
      'log_type'
    ];

    let csvContent = UTF8_BOM + headers.join(',') + '\n';

    // Add warning comment if truncated
    if (isTruncated) {
      csvContent += `# Warning: Results truncated to ${MAX_ROWS} rows\n`;
    }

    // Add data rows
    for (const log of limitedLogs) {
      const row = [
        escapeCSV(log.timestamp),
        escapeCSV(log.user_email),
        escapeCSV(log.activity_type),
        escapeCSV(log.action_type),
        escapeCSV(log.details),
        escapeCSV(log.admin_email),
        escapeCSV(log.ip_address),
        escapeCSV(log.user_agent),
        escapeCSV(log.log_type)
      ];
      csvContent += row.join(',') + '\n';
    }

    // Generate filename with current timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
    const filename = `audit-log-export-${timestamp}.csv`;

    // Log the export action for audit trail
    try {
      await db.insert(adminAuditLog).values({
        timestamp: new Date(),
        adminUserId: admin,
          adminEmail: 'admin',
        actionType: 'ASSET_VIEW', // Using existing enum value as closest match
        targetType: 'audit_log_export',
        targetId: null,
        details: JSON.stringify({
          action: 'CSV export',
          filters: {
            userId: userId || null,
            activityType: activityType || null,
            actionType: actionType || null,
            startDate: startDate || null,
            endDate: endDate || null
          },
          rowCount: limitedLogs.length,
          truncated: isTruncated
        })
      });
    } catch (logError) {
      console.error('Failed to log export action:', logError);
      // Continue with export even if logging fails
    }

    // Return CSV response
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });

  } catch (error) {
    console.error('GET error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
      code: 'INTERNAL_SERVER_ERROR'
    }, { status: 500 });
  }
}