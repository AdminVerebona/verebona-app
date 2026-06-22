import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetTypes, assetTypeSubcategories, adminAuditLog } from '@/db/schema';
import { asc, eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    // ✅ Use JWT authentication via middleware + requireAdmin
    await requireAdmin(request);

    // Fetch all asset types sorted by displayOrder
    const allAssetTypes = await db.select()
      .from(assetTypes)
      .orderBy(asc(assetTypes.displayOrder));

    // Fetch all subcategories for these asset types
    const allSubcategories = await db.select()
      .from(assetTypeSubcategories)
      .orderBy(asc(assetTypeSubcategories.displayOrder));

    // Group subcategories by assetTypeId
    const subcategoriesMap = new Map<number, typeof allSubcategories>();
    for (const subcategory of allSubcategories) {
      const existing = subcategoriesMap.get(subcategory.assetTypeId) || [];
      existing.push(subcategory);
      subcategoriesMap.set(subcategory.assetTypeId, existing);
    }

    // Combine asset types with their subcategories
    const assetTypesWithSubcategories = allAssetTypes.map(assetType => ({
      ...assetType,
      subcategories: subcategoriesMap.get(assetType.id) || []
    }));

    return NextResponse.json(assetTypesWithSubcategories, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('GET error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
      code: 'INTERNAL_SERVER_ERROR'
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    // ✅ Use JWT authentication via middleware + requireAdmin
    await requireAdmin(request);
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json(
        { error: 'Authentication required', code: 'UNAUTHORIZED' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { code, label, icon, isEnabled, displayOrder } = body;

    // Validation
    if (!code || !label) {
      return NextResponse.json({ 
        error: 'Le code et le libellé sont requis',
        code: 'VALIDATION_ERROR'
      }, { status: 400 });
    }

    // Check if code already exists
    const existingType = await db.select()
      .from(assetTypes)
      .where(eq(assetTypes.code, code))
      .limit(1);

    if (existingType.length > 0) {
      return NextResponse.json({ 
        error: 'Un type de bien avec ce code existe déjà',
        code: 'CODE_ALREADY_EXISTS'
      }, { status: 409 });
    }

    // Create new asset type
    const now = new Date();
    const [newAssetType] = await db.insert(assetTypes).values({
      code: code.toUpperCase(),
      label,
      icon: icon || null,
      isEnabled: isEnabled !== undefined ? isEnabled : true,
      displayOrder: displayOrder || 0,
      createdAt: now,
      updatedAt: now,
    }).returning();

    // Log admin action
    await db.insert(adminAuditLog).values({
      timestamp: now,
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'ASSET_TYPE_CREATE',
      targetType: 'asset_type',
      targetId: newAssetType.id,
      details: JSON.stringify({ code: newAssetType.code, label: newAssetType.label }),
    });

    return NextResponse.json(newAssetType, { status: 201 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('POST error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
      code: 'INTERNAL_SERVER_ERROR'
    }, { status: 500 });
  }
}