import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

    // Authorization check - only ADMIN can reactivate users
    if (currentUser.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden: ADMIN role required', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    // Extract and validate ID from params
    const userId = params.id;
    if (!userId || isNaN(parseInt(userId))) {
      return NextResponse.json(
        { error: 'Valid user ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const userIdInt = parseInt(userId);

    // Check if user exists
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.id, userIdInt))
      .limit(1);

    if (existingUser.length === 0) {
      return NextResponse.json(
        { error: 'User not found', code: 'USER_NOT_FOUND' },
        { status: 404 }
      );
    }

    // Update user status to ACTIVE
    const updatedUser = await db
      .update(users)
      .set({
        status: 'ACTIVE',
        updatedAt: new Date(),
      })
      .where(eq(users.id, userIdInt))
      .returning();

    if (updatedUser.length === 0) {
      return NextResponse.json(
        { error: 'Failed to reactivate user', code: 'UPDATE_FAILED' },
        { status: 500 }
      );
    }

    // Get admin user details for audit log
    const adminEmail = currentUser.email;

    // Create audit log entry
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: parseInt(adminUserId),
      adminEmail: adminEmail,
      actionType: 'USER_REACTIVATE',
      targetType: 'USER',
      targetId: userIdInt,
      details: null,
    });

    // Remove passwordHash from response
    const { passwordHash, ...userWithoutPassword } = updatedUser[0];

    return NextResponse.json(userWithoutPassword, { status: 200 });
  } catch (error) {
    console.error('POST /api/admin/users/[id]/reactivate error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
        code: 'INTERNAL_SERVER_ERROR',
      },
      { status: 500 }
    );
  }
}