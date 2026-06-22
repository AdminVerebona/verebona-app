import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetTypeSubcategories, assetTypes, adminAuditLog } from '@/db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const searchParams = request.nextUrl.searchParams;
    const assetTypeId = searchParams.get('assetTypeId');

    let query = db
      .select({
        id: assetTypeSubcategories.id,
        assetTypeId: assetTypeSubcategories.assetTypeId,
        code: assetTypeSubcategories.code,
        label: assetTypeSubcategories.label,
        icon: assetTypeSubcategories.icon,
        isEnabled: assetTypeSubcategories.isEnabled,
        displayOrder: assetTypeSubcategories.displayOrder,
        createdAt: assetTypeSubcategories.createdAt,
        updatedAt: assetTypeSubcategories.updatedAt,
        assetType: {
          id: assetTypes.id,
          code: assetTypes.code,
          label: assetTypes.label,
          icon: assetTypes.icon,
          isEnabled: assetTypes.isEnabled,
        },
      })
        .from(assetTypeSubcategories)
        .leftJoin(assetTypes, eq(assetTypeSubcategories.assetTypeId, assetTypes.id))
        .$dynamic();

    if (assetTypeId) {
      const parsedAssetTypeId = parseInt(assetTypeId);
      if (isNaN(parsedAssetTypeId)) {
        return NextResponse.json(
          { error: 'Invalid assetTypeId parameter', code: 'INVALID_ASSET_TYPE_ID' },
          { status: 400 }
        );
      }
      query = query.where(eq(assetTypeSubcategories.assetTypeId, parsedAssetTypeId));
    }

    const results = await query.orderBy(asc(assetTypeSubcategories.displayOrder));

    return NextResponse.json(results);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('GET error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);

    const session = await getSession(request);

    const body = await request.json();
    const { assetTypeId, code, label, icon, isEnabled, displayOrder } = body;

    if (!assetTypeId) {
      return NextResponse.json(
        { error: 'assetTypeId is required', code: 'MISSING_ASSET_TYPE_ID' },
        { status: 400 }
      );
    }

    if (!code || typeof code !== 'string' || code.trim() === '') {
      return NextResponse.json(
        { error: 'code is required and must be a non-empty string', code: 'INVALID_CODE' },
        { status: 400 }
      );
    }

    if (!label || typeof label !== 'string' || label.trim() === '') {
      return NextResponse.json(
        { error: 'label is required and must be a non-empty string', code: 'INVALID_LABEL' },
        { status: 400 }
      );
    }

    const parsedAssetTypeId = parseInt(assetTypeId);
    if (isNaN(parsedAssetTypeId)) {
      return NextResponse.json(
        { error: 'assetTypeId must be a valid integer', code: 'INVALID_ASSET_TYPE_ID' },
        { status: 400 }
      );
    }

    const existingAssetType = await db
      .select()
      .from(assetTypes)
      .where(eq(assetTypes.id, parsedAssetTypeId))
      .limit(1);

    if (existingAssetType.length === 0) {
      return NextResponse.json(
        { error: 'Asset type not found', code: 'ASSET_TYPE_NOT_FOUND' },
        { status: 404 }
      );
    }

    if (isEnabled !== undefined && typeof isEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'isEnabled must be a boolean', code: 'INVALID_IS_ENABLED' },
        { status: 400 }
      );
    }

    if (displayOrder !== undefined) {
      const parsedDisplayOrder = parseInt(displayOrder);
      if (isNaN(parsedDisplayOrder) || parsedDisplayOrder < 0) {
        return NextResponse.json(
          { error: 'displayOrder must be a valid integer >= 0', code: 'INVALID_DISPLAY_ORDER' },
          { status: 400 }
        );
      }
    }

    const now = new Date();
    const insertData: any = {
      assetTypeId: parsedAssetTypeId,
      code: code.trim(),
      label: label.trim(),
      icon: icon || null,
      isEnabled: isEnabled !== undefined ? isEnabled : true,
      displayOrder: displayOrder !== undefined ? parseInt(displayOrder) : 0,
      createdAt: now,
      updatedAt: now,
    };

    const newSubcategory = await db
      .insert(assetTypeSubcategories)
      .values(insertData)
      .returning();

    if (newSubcategory.length === 0) {
      return NextResponse.json(
        { error: 'Failed to create subcategory', code: 'CREATE_FAILED' },
        { status: 500 }
      );
    }

    const created = newSubcategory[0];

    await db.insert(adminAuditLog).values({
      timestamp: now,
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'SUBCATEGORY_CREATE',
      targetType: 'ASSET_TYPE_SUBCATEGORY',
      targetId: created.id,
      details: JSON.stringify({
        assetTypeId: created.assetTypeId,
        code: created.code,
        label: created.label,
        icon: created.icon,
        isEnabled: created.isEnabled,
        displayOrder: created.displayOrder,
      }),
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('POST error:', error);
    
    if ((error as Error).message.includes('UNIQUE constraint failed')) {
      return NextResponse.json(
        { error: 'A subcategory with this code already exists', code: 'DUPLICATE_CODE' },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Internal server error: ' + (error as Error).message },
      { status: 500 }
    );
  }
}