import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetTypeSubcategories, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(request);

    const session = await getSession(request);

    // Extract and validate ID
    const { id } = await params;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const subcategoryId = parseInt(id);

    // Check if subcategory exists
    const existingSubcategory = await db
      .select()
      .from(assetTypeSubcategories)
      .where(eq(assetTypeSubcategories.id, subcategoryId))
      .limit(1);

    if (existingSubcategory.length === 0) {
      return NextResponse.json(
        { error: 'Subcategory not found', code: 'SUBCATEGORY_NOT_FOUND' },
        { status: 404 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { label, icon, isEnabled, displayOrder } = body;

    // Validation
    if (label !== undefined) {
      if (typeof label !== 'string' || label.trim().length === 0) {
        return NextResponse.json(
          { error: 'Label must be a non-empty string', code: 'INVALID_LABEL' },
          { status: 400 }
        );
      }
    }

    if (isEnabled !== undefined) {
      if (typeof isEnabled !== 'boolean') {
        return NextResponse.json(
          { error: 'isEnabled must be a boolean', code: 'INVALID_IS_ENABLED' },
          { status: 400 }
        );
      }
    }

    if (displayOrder !== undefined) {
      if (typeof displayOrder !== 'number' || displayOrder < 0 || !Number.isInteger(displayOrder)) {
        return NextResponse.json(
          { error: 'displayOrder must be a valid integer >= 0', code: 'INVALID_DISPLAY_ORDER' },
          { status: 400 }
        );
      }
    }

    if (icon !== undefined && icon !== null) {
      if (typeof icon !== 'string') {
        return NextResponse.json(
          { error: 'icon must be a string or null', code: 'INVALID_ICON' },
          { status: 400 }
        );
      }
    }

    // Prepare update data
    const updates: Record<string, any> = {
      updatedAt: new Date()
    };

    const updatedFields: Array<{ field: string; oldValue: any; newValue: any }> = [];

    if (label !== undefined) {
      const trimmedLabel = label.trim();
      updates.label = trimmedLabel;
      if (existingSubcategory[0].label !== trimmedLabel) {
        updatedFields.push({
          field: 'label',
          oldValue: existingSubcategory[0].label,
          newValue: trimmedLabel
        });
      }
    }

    if (icon !== undefined) {
      updates.icon = icon;
      if (existingSubcategory[0].icon !== icon) {
        updatedFields.push({
          field: 'icon',
          oldValue: existingSubcategory[0].icon,
          newValue: icon
        });
      }
    }

    if (isEnabled !== undefined) {
      updates.isEnabled = isEnabled;
      if (existingSubcategory[0].isEnabled !== isEnabled) {
        updatedFields.push({
          field: 'isEnabled',
          oldValue: existingSubcategory[0].isEnabled,
          newValue: isEnabled
        });
      }
    }

    if (displayOrder !== undefined) {
      updates.displayOrder = displayOrder;
      if (existingSubcategory[0].displayOrder !== displayOrder) {
        updatedFields.push({
          field: 'displayOrder',
          oldValue: existingSubcategory[0].displayOrder,
          newValue: displayOrder
        });
      }
    }

    // Update subcategory
    const updatedSubcategory = await db
      .update(assetTypeSubcategories)
      .set(updates)
      .where(eq(assetTypeSubcategories.id, subcategoryId))
      .returning();

    if (updatedSubcategory.length === 0) {
      return NextResponse.json(
        { error: 'Failed to update subcategory', code: 'UPDATE_FAILED' },
        { status: 500 }
      );
    }

    // Audit log
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'SUBCATEGORY_UPDATE',
      targetType: 'ASSET_TYPE_SUBCATEGORY',
      targetId: subcategoryId,
      details: JSON.stringify({
        updatedFields,
        subcategoryCode: existingSubcategory[0].code,
        subcategoryLabel: existingSubcategory[0].label
      })
    });

    return NextResponse.json(updatedSubcategory[0], { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('PUT error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(request);

    const session = await getSession(request);

    // Extract and validate ID
    const { id } = await params;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const subcategoryId = parseInt(id);

    // Check if subcategory exists
    const existingSubcategory = await db
      .select()
      .from(assetTypeSubcategories)
      .where(eq(assetTypeSubcategories.id, subcategoryId))
      .limit(1);

    if (existingSubcategory.length === 0) {
      return NextResponse.json(
        { error: 'Subcategory not found', code: 'SUBCATEGORY_NOT_FOUND' },
        { status: 404 }
      );
    }

    // Delete subcategory
    const deletedSubcategory = await db
      .delete(assetTypeSubcategories)
      .where(eq(assetTypeSubcategories.id, subcategoryId))
      .returning();

    if (deletedSubcategory.length === 0) {
      return NextResponse.json(
        { error: 'Failed to delete subcategory', code: 'DELETE_FAILED' },
        { status: 500 }
      );
    }

    // Audit log
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'SUBCATEGORY_DELETE',
      targetType: 'ASSET_TYPE_SUBCATEGORY',
      targetId: subcategoryId,
      details: JSON.stringify({
        deletedCode: existingSubcategory[0].code,
        deletedLabel: existingSubcategory[0].label,
        assetTypeId: existingSubcategory[0].assetTypeId
      })
    });

    return NextResponse.json(
      {
        message: 'Subcategory deleted successfully',
        deleted: deletedSubcategory[0]
      },
      { status: 200 }
    );

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('DELETE error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}