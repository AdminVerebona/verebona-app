/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * REFD-006 : aucun CRUD des référentiels depuis le BO.
 * POST supprimé, ainsi que PUT/DELETE de `[id]` et les associations bien/export.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTypes, documentTypeAssetAssociations, documentTypeExportAssociations, assetTypes, assetTypeSubcategories } from '@/db/schema';
import { eq, like, or, and } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    await await requireAdmin(request);

    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get('search');
    const isActiveParam = searchParams.get('isActive');

    let query = db.select({
      id: documentTypes.id,
      code: documentTypes.code,
      label: documentTypes.label,
      description: documentTypes.description,
      isActive: documentTypes.isActive,
      displayOrder: documentTypes.displayOrder,
      createdAt: documentTypes.createdAt,
      updatedAt: documentTypes.updatedAt,
      }).from(documentTypes).$dynamic();

    const conditions = [];

    if (search) {
      conditions.push(
        or(
          like(documentTypes.code, `%${search}%`),
          like(documentTypes.label, `%${search}%`)
        )
      );
    }

    if (isActiveParam !== null) {
      const isActive = isActiveParam === 'true';
      conditions.push(eq(documentTypes.isActive, isActive));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const results = await query.orderBy(documentTypes.displayOrder);

    const documentTypesWithAssociations = await Promise.all(
      results.map(async (docType) => {
        const assetAssocs = await db.select({
          id: documentTypeAssetAssociations.id,
          isRequired: documentTypeAssetAssociations.isRequired,
          assetTypeId: assetTypes.id,
          assetTypeCode: assetTypes.code,
          assetTypeLabel: assetTypes.label,
          subcategoryId: assetTypeSubcategories.id,
          subcategoryCode: assetTypeSubcategories.code,
          subcategoryLabel: assetTypeSubcategories.label,
        })
          .from(documentTypeAssetAssociations)
          .leftJoin(assetTypes, eq(documentTypeAssetAssociations.assetTypeId, assetTypes.id))
          .leftJoin(assetTypeSubcategories, eq(documentTypeAssetAssociations.assetTypeSubcategoryId, assetTypeSubcategories.id))
          .where(eq(documentTypeAssetAssociations.documentTypeId, docType.id));

        const exportAssocs = await db.select({
          id: documentTypeExportAssociations.id,
          exportType: documentTypeExportAssociations.exportType,
          includeByDefault: documentTypeExportAssociations.includeByDefault,
          displayOrder: documentTypeExportAssociations.displayOrder,
        })
          .from(documentTypeExportAssociations)
          .where(eq(documentTypeExportAssociations.documentTypeId, docType.id));

        return {
          ...docType,
          assetAssociations: assetAssocs.map(assoc => ({
            id: assoc.id,
            assetType: assoc.assetTypeId ? {
              id: assoc.assetTypeId,
              code: assoc.assetTypeCode,
              label: assoc.assetTypeLabel,
            } : null,
            assetTypeSubcategory: assoc.subcategoryId ? {
              id: assoc.subcategoryId,
              code: assoc.subcategoryCode,
              label: assoc.subcategoryLabel,
            } : null,
            isRequired: assoc.isRequired,
          })),
          exportAssociations: exportAssocs.map(assoc => ({
            id: assoc.id,
            exportType: assoc.exportType,
            includeByDefault: assoc.includeByDefault,
            displayOrder: assoc.displayOrder,
          })),
        };
      })
    );

    return NextResponse.json(documentTypesWithAssociations, { status: 200 });
  } catch (error: any) {
    if (error.message === 'Admin access required') {
      return NextResponse.json({ error: 'Admin access required', code: 'FORBIDDEN' }, { status: 403 });
    }
    console.error('GET error:', error);
    return NextResponse.json({ error: 'Internal server error: ' + error.message }, { status: 500 });
  }
}

