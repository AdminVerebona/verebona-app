import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetTypes, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { getSession } from '@/lib/auth-guards';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // ✅ Use JWT authentication via middleware + requireAdmin
    await requireAdmin(request);
    
    // Get session for audit log
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json(
        { error: 'Authentication required', code: 'UNAUTHORIZED' },
        { status: 401 }
      );
    }

    // Await params (Next.js 15 requirement)
    const { id } = await params;
    
    // Extract and validate ID from params
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid asset type ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const assetTypeId = parseInt(id);

    // Parse request body
    const body = await request.json();
    const { label, icon, isEnabled, displayOrder } = body;

    // Security check: reject if userId provided in body
    if ('userId' in body || 'user_id' in body) {
      return NextResponse.json(
        {
          error: 'User ID cannot be provided in request body',
          code: 'USER_ID_NOT_ALLOWED',
        },
        { status: 400 }
      );
    }

    // Check if asset type exists
    const existingAssetType = await db
      .select()
      .from(assetTypes)
      .where(eq(assetTypes.id, assetTypeId))
      .limit(1);

    if (existingAssetType.length === 0) {
      return NextResponse.json(
        { error: 'Asset type not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    // Build update object with only provided fields
    const updateData: any = {
      updatedAt: new Date(),
    };

    const updatedFields: any = {};

    if (label !== undefined) {
      updateData.label = label.trim();
      updatedFields.label = label.trim();
    }

    if (icon !== undefined) {
      updateData.icon = icon;
      updatedFields.icon = icon;
    }

    if (isEnabled !== undefined) {
      updateData.isEnabled = isEnabled;
      updatedFields.isEnabled = isEnabled;
    }

    if (displayOrder !== undefined) {
      if (isNaN(parseInt(displayOrder.toString()))) {
        return NextResponse.json(
          { error: 'Display order must be a valid number', code: 'INVALID_DISPLAY_ORDER' },
          { status: 400 }
        );
      }
      updateData.displayOrder = parseInt(displayOrder.toString());
      updatedFields.displayOrder = parseInt(displayOrder.toString());
    }

    // Update asset type
    const updatedAssetType = await db
      .update(assetTypes)
      .set(updateData)
      .where(eq(assetTypes.id, assetTypeId))
      .returning();

    if (updatedAssetType.length === 0) {
      return NextResponse.json(
        { error: 'Failed to update asset type', code: 'UPDATE_FAILED' },
        { status: 500 }
      );
    }

    // Create audit log entry
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'ASSET_TYPE_UPDATE',
      targetType: 'ASSET_TYPE',
      targetId: assetTypeId,
      details: JSON.stringify({
        updatedFields,
        previousValues: {
          label: existingAssetType[0].label,
          icon: existingAssetType[0].icon,
          isEnabled: existingAssetType[0].isEnabled,
          displayOrder: existingAssetType[0].displayOrder,
        },
      }),
    });

    return NextResponse.json(updatedAssetType[0], { status: 200 });
  } catch (error: any) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('PUT /api/asset-types/[id] error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + error.message },
      { status: 500 }
    );
  }
}