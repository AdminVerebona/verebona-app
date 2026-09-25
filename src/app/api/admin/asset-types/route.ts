/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * REFD-006 : aucun CRUD des référentiels depuis le BO (versionnés dans le code / seeds).
 * POST supprimé, ainsi que `asset-types/[id]` (PUT).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetTypes, assetTypeSubcategories } from '@/db/schema';
import { asc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

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

