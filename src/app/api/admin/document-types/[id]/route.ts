/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * REFD-006 : consultation seule ; PUT et DELETE supprimés.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTypes, documentTypeAssetAssociations, documentTypeExportAssociations, assetTypes, assetTypeSubcategories } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await await requireAdmin(request);

    const { id } = await params;

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({ 
        error: "Valid document type ID is required",
        code: "INVALID_ID" 
      }, { status: 400 });
    }

    const documentTypeId = parseInt(id);

    const documentType = await db.select()
      .from(documentTypes)
      .where(eq(documentTypes.id, documentTypeId))
      .limit(1);

    if (documentType.length === 0) {
      return NextResponse.json({ 
        error: "Document type not found",
        code: "NOT_FOUND" 
      }, { status: 404 });
    }

    const assetAssociationsRaw = await db.select({
      id: documentTypeAssetAssociations.id,
      documentTypeId: documentTypeAssetAssociations.documentTypeId,
      assetTypeId: documentTypeAssetAssociations.assetTypeId,
      assetTypeSubcategoryId: documentTypeAssetAssociations.assetTypeSubcategoryId,
      isRequired: documentTypeAssetAssociations.isRequired,
      createdAt: documentTypeAssetAssociations.createdAt,
      assetTypeCode: assetTypes.code,
      assetTypeLabel: assetTypes.label,
      subcategoryCode: assetTypeSubcategories.code,
      subcategoryLabel: assetTypeSubcategories.label,
    })
      .from(documentTypeAssetAssociations)
      .leftJoin(assetTypes, eq(documentTypeAssetAssociations.assetTypeId, assetTypes.id))
      .leftJoin(assetTypeSubcategories, eq(documentTypeAssetAssociations.assetTypeSubcategoryId, assetTypeSubcategories.id))
      .where(eq(documentTypeAssetAssociations.documentTypeId, documentTypeId));

    const exportAssociationsRaw = await db.select({
      id: documentTypeExportAssociations.id,
      documentTypeId: documentTypeExportAssociations.documentTypeId,
      exportType: documentTypeExportAssociations.exportType,
      includeByDefault: documentTypeExportAssociations.includeByDefault,
      displayOrder: documentTypeExportAssociations.displayOrder,
      createdAt: documentTypeExportAssociations.createdAt,
    })
      .from(documentTypeExportAssociations)
      .where(eq(documentTypeExportAssociations.documentTypeId, documentTypeId));

    const assetAssociations = assetAssociationsRaw.map(assoc => ({
      id: assoc.id,
      documentTypeId: assoc.documentTypeId,
      assetTypeId: assoc.assetTypeId,
      assetTypeSubcategoryId: assoc.assetTypeSubcategoryId,
      isRequired: assoc.isRequired,
      createdAt: assoc.createdAt,
      assetType: assoc.assetTypeId ? {
        code: assoc.assetTypeCode,
        label: assoc.assetTypeLabel,
      } : null,
      subcategory: assoc.assetTypeSubcategoryId ? {
        code: assoc.subcategoryCode,
        label: assoc.subcategoryLabel,
      } : null,
    }));

    const exportAssociations = exportAssociationsRaw.map(assoc => ({
      id: assoc.id,
      documentTypeId: assoc.documentTypeId,
      exportType: assoc.exportType,
      includeByDefault: assoc.includeByDefault,
      displayOrder: assoc.displayOrder,
      createdAt: assoc.createdAt,
    }));

    return NextResponse.json({
      ...documentType[0],
      assetAssociations,
      exportAssociations,
    }, { status: 200 });

  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ 
        error: 'Admin access required',
        code: 'UNAUTHORIZED' 
      }, { status: 403 });
    }
    console.error('GET document type error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + error.message 
    }, { status: 500 });
  }
}

