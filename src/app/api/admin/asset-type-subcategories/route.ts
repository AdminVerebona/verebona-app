/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * REFD-006 : aucun CRUD des référentiels depuis le BO.
 * POST supprimé, ainsi que `asset-type-subcategories/[id]` (PUT, DELETE).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetTypeSubcategories, assetTypes } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

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

