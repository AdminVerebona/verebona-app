import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  try {
    // Get admin user ID from header (placeholder auth)
    const adminUserId = request.headers.get('x-user-id');
    if (!adminUserId || isNaN(parseInt(adminUserId))) {
      return NextResponse.json(
        { error: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' },
        { status: 401 }
      );
    }

    // Fetch admin user to check role
    const adminUserResult = await db
      .select()
      .from(users)
      .where(eq(users.id, parseInt(adminUserId)))
      .limit(1);

    if (adminUserResult.length === 0) {
      return NextResponse.json(
        { error: 'Admin user not found', code: 'ADMIN_NOT_FOUND' },
        { status: 404 }
      );
    }

    const currentUser = adminUserResult[0];

    // Check if user has ADMIN role
    if (currentUser.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Access forbidden: ADMIN role required', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    // Validate ID parameter
    const userId = params.id;
    if (!userId || isNaN(parseInt(userId))) {
      return NextResponse.json(
        { error: 'Valid user ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    // Fetch target user by ID
    const targetUserResult = await db
      .select()
      .from(users)
      .where(eq(users.id, parseInt(userId)))
      .limit(1);

    if (targetUserResult.length === 0) {
      return NextResponse.json(
        { error: 'User not found', code: 'USER_NOT_FOUND' },
        { status: 404 }
      );
    }

    const targetUser = targetUserResult[0];

    // V1: Log to console that password reset would be sent

    // Create audit log entry
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: parseInt(adminUserId),
      adminEmail: currentUser.email,
      actionType: 'PASSWORD_RESET_SENT',
      targetType: 'USER',
      targetId: targetUser.id,
      details: JSON.stringify({
        userEmail: targetUser.email,
      }),
    });

    // Return success message
    return NextResponse.json(
      {
        success: true,
        message: `Password reset email would be sent to ${targetUser.email}`,
        userEmail: targetUser.email,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('POST password reset error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
        code: 'INTERNAL_ERROR',
      },
      { status: 500 }
    );
  }
}