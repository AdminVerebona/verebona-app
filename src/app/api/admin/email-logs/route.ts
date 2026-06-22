import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { emailLogs, users } from '@/db/schema';
import { eq, like, and, desc, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    // Require admin authentication
    await requireAdmin(request);

    const { searchParams } = new URL(request.url);

    // Extract and validate query parameters
    const status = searchParams.get('status');
    const templateCode = searchParams.get('templateCode');
    const recipientEmail = searchParams.get('recipientEmail');
    const limitParam = searchParams.get('limit');
    const pageParam = searchParams.get('page');

    // Validate status if provided
    const validStatuses = ['sent', 'failed', 'pending'];
    if (status && !validStatuses.includes(status)) {
      return NextResponse.json({
        error: 'Invalid status. Must be one of: sent, failed, pending',
        code: 'INVALID_STATUS'
      }, { status: 400 });
    }

    // Parse and validate limit
    let limit = 50;
    if (limitParam) {
      limit = parseInt(limitParam);
      if (isNaN(limit) || limit < 1 || limit > 200) {
        return NextResponse.json({
          error: 'Invalid limit. Must be between 1 and 200',
          code: 'INVALID_LIMIT'
        }, { status: 400 });
      }
    }

    // Parse and validate page
    let page = 1;
    if (pageParam) {
      page = parseInt(pageParam);
      if (isNaN(page) || page < 1) {
        return NextResponse.json({
          error: 'Invalid page. Must be >= 1',
          code: 'INVALID_PAGE'
        }, { status: 400 });
      }
    }

    // Calculate offset
    const offset = (page - 1) * limit;

    // Build WHERE conditions
    const conditions = [];
    
    if (status) {
      conditions.push(eq(emailLogs.status, status as 'sent' | 'failed' | 'pending'));
    }
    
    if (templateCode) {
      conditions.push(eq(emailLogs.templateCode, templateCode));
    }
    
    if (recipientEmail) {
      conditions.push(like(emailLogs.recipientEmail, `%${recipientEmail}%`));
    }

    // Build base query with LEFT JOIN to users
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Fetch email logs with user information
    const logs = await db
      .select({
        id: emailLogs.id,
        templateCode: emailLogs.templateCode,
        recipientEmail: emailLogs.recipientEmail,
        recipientUserId: emailLogs.recipientUserId,
        subject: emailLogs.subject,
        status: emailLogs.status,
        errorMessage: emailLogs.errorMessage,
        sentAt: emailLogs.sentAt,
        metadata: emailLogs.metadata,
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName
        }
      })
      .from(emailLogs)
      .leftJoin(users, eq(emailLogs.recipientUserId, users.id))
      .where(whereClause)
      .orderBy(desc(emailLogs.sentAt))
      .limit(limit)
      .offset(offset);

    // Format the response to handle null user joins
    const formattedLogs = logs.map(log => ({
      id: log.id,
      templateCode: log.templateCode,
      recipientEmail: log.recipientEmail,
      recipientUserId: log.recipientUserId,
      subject: log.subject,
      status: log.status,
      errorMessage: log.errorMessage,
      sentAt: log.sentAt,
      metadata: log.metadata,
        user: log.user?.id ? {
          id: log.user.id,
          email: log.user.email,
          firstName: log.user.firstName,
          lastName: log.user.lastName
        } : null
    }));

    // Get total count for pagination
    const countQuery = await db
      .select({ count: sql<number>`count(*)` })
      .from(emailLogs)
      .where(whereClause);

    const total = Number(countQuery[0]?.count || 0);

    return NextResponse.json({
      data: formattedLogs,
      pagination: {
        page,
        limit,
        total
      }
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('GET email logs error:', error);
    return NextResponse.json({
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
      code: 'INTERNAL_SERVER_ERROR'
    }, { status: 500 });
  }
}