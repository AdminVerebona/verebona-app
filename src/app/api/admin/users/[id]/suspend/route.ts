import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Extract and validate user ID from params
    const userId = params.id;
    if (!userId || isNaN(parseInt(userId))) {
      return NextResponse.json(
        { error: 'Valid user ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    // Get admin user ID from headers (placeholder for now, will be integrated with auth later)
    const adminUserId = request.headers.get('x-admin-user-id');
    if (!adminUserId || isNaN(parseInt(adminUserId))) {
      return NextResponse.json(
        { error: 'Admin authentication required', code: 'ADMIN_AUTH_REQUIRED' },
        { status: 401 }
      );
    }

    // Fetch admin user to check role
    const adminUser = await db
      .select()
      .from(users)
      .where(eq(users.id, parseInt(adminUserId)))
      .limit(1);

    if (adminUser.length === 0) {
      return NextResponse.json(
        { error: 'Admin user not found', code: 'ADMIN_NOT_FOUND' },
        { status: 404 }
      );
    }

    // Check if admin has ADMIN role
    if (adminUser[0].role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Access denied. ADMIN role required', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const { reason } = body;

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return NextResponse.json(
        { error: 'Suspension reason is required', code: 'MISSING_REASON' },
        { status: 400 }
      );
    }

    // Check if target user exists
    const targetUser = await db
      .select()
      .from(users)
      .where(eq(users.id, parseInt(userId)))
      .limit(1);

    if (targetUser.length === 0) {
      return NextResponse.json(
        { error: 'User not found', code: 'USER_NOT_FOUND' },
        { status: 404 }
      );
    }

    // Update user status to SUSPENDED
    const updatedUser = await db
      .update(users)
      .set({
        status: 'SUSPENDED',
        updatedAt: new Date(),
      })
      .where(eq(users.id, parseInt(userId)))
      .returning();

    if (updatedUser.length === 0) {
      return NextResponse.json(
        { error: 'Failed to suspend user', code: 'UPDATE_FAILED' },
        { status: 500 }
      );
    }

    // Create audit log entry
    const auditDetails = {
      reason: reason.trim(),
      previousStatus: targetUser[0].status,
      newStatus: 'SUSPENDED',
    };

    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: parseInt(adminUserId),
      adminEmail: adminUser[0].email,
      actionType: 'USER_SUSPEND',
      targetType: 'USER',
      targetId: parseInt(userId),
      details: JSON.stringify(auditDetails),
    });

    // Return updated user without passwordHash
    const { passwordHash, ...userWithoutPassword } = updatedUser[0];

    return NextResponse.json(userWithoutPassword, { status: 200 });
  } catch (error) {
    console.error('POST error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}