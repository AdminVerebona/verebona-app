import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTypes, documentTypeAssetAssociations, documentTypeExportAssociations, assetTypes, assetTypeSubcategories, assetFiles, adminAuditLog } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

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

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await await requireAdmin(request);
    const session = await getSession(request);

    if (!session?.userId || !session?.email) {
      return NextResponse.json({ 
        error: 'Session information missing',
        code: 'SESSION_ERROR' 
      }, { status: 401 });
    }

    const { id } = await params;

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({ 
        error: "Valid document type ID is required",
        code: "INVALID_ID" 
      }, { status: 400 });
    }

    const documentTypeId = parseInt(id);
    const body = await request.json();

    if ('code' in body) {
      return NextResponse.json({ 
        error: "Code field is immutable and cannot be modified",
        code: "CODE_IMMUTABLE" 
      }, { status: 400 });
    }

    const existingDocumentType = await db.select()
      .from(documentTypes)
      .where(eq(documentTypes.id, documentTypeId))
      .limit(1);

    if (existingDocumentType.length === 0) {
      return NextResponse.json({ 
        error: "Document type not found",
        code: "NOT_FOUND" 
      }, { status: 404 });
    }

    const { label, description, examples, isActive, displayOrder, assetAssociations, exportAssociations } = body;
    const changedFields: string[] = [];

    if (label !== undefined) {
      if (typeof label !== 'string' || label.trim() === '') {
        return NextResponse.json({ 
          error: "Label must be a non-empty string",
          code: "INVALID_LABEL" 
        }, { status: 400 });
      }
      if (label !== existingDocumentType[0].label) {
        changedFields.push('label');
      }
    }

    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') {
        return NextResponse.json({ 
          error: "isActive must be a boolean",
          code: "INVALID_IS_ACTIVE" 
        }, { status: 400 });
      }
      if (isActive !== existingDocumentType[0].isActive) {
        changedFields.push('isActive');
      }
    }

    if (displayOrder !== undefined) {
      if (!Number.isInteger(displayOrder) || displayOrder < 0) {
        return NextResponse.json({ 
          error: "displayOrder must be an integer >= 0",
          code: "INVALID_DISPLAY_ORDER" 
        }, { status: 400 });
      }
      if (displayOrder !== existingDocumentType[0].displayOrder) {
        changedFields.push('displayOrder');
      }
    }

    if (description !== undefined && description !== existingDocumentType[0].description) {
      changedFields.push('description');
    }

      if (examples !== undefined && examples !== (existingDocumentType[0] as any).examples) {
      changedFields.push('examples');
    }

    const updateData: any = {
      updatedAt: new Date(),
    };

    if (label !== undefined) updateData.label = label.trim();
    if (description !== undefined) updateData.description = description;
    if (examples !== undefined) updateData.examples = examples;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (displayOrder !== undefined) updateData.displayOrder = displayOrder;

    const updated = await db.update(documentTypes)
      .set(updateData)
      .where(eq(documentTypes.id, documentTypeId))
      .returning();

    if (assetAssociations !== undefined) {
      if (!Array.isArray(assetAssociations)) {
        return NextResponse.json({ 
          error: "assetAssociations must be an array",
          code: "INVALID_ASSET_ASSOCIATIONS" 
        }, { status: 400 });
      }

      await db.delete(documentTypeAssetAssociations)
        .where(eq(documentTypeAssetAssociations.documentTypeId, documentTypeId));

      if (assetAssociations.length > 0) {
        const associationsToInsert = assetAssociations.map(assoc => ({
          documentTypeId,
          assetTypeId: assoc.assetTypeId || null,
          assetTypeSubcategoryId: assoc.assetTypeSubcategoryId || null,
          isRequired: assoc.isRequired ?? false,
          createdAt: new Date(),
        }));

        await db.insert(documentTypeAssetAssociations)
          .values(associationsToInsert);
      }

      changedFields.push('assetAssociations');
    }

    if (exportAssociations !== undefined) {
      if (!Array.isArray(exportAssociations)) {
        return NextResponse.json({ 
          error: "exportAssociations must be an array",
          code: "INVALID_EXPORT_ASSOCIATIONS" 
        }, { status: 400 });
      }

      await db.delete(documentTypeExportAssociations)
        .where(eq(documentTypeExportAssociations.documentTypeId, documentTypeId));

      if (exportAssociations.length > 0) {
        const associationsToInsert = exportAssociations.map(assoc => ({
          documentTypeId,
          exportType: assoc.exportType || null,
          includeByDefault: assoc.includeByDefault ?? true,
          displayOrder: assoc.displayOrder ?? 0,
          createdAt: new Date(),
        }));

        await db.insert(documentTypeExportAssociations)
          .values(associationsToInsert);
      }

      changedFields.push('exportAssociations');
    }

    if (changedFields.length > 0) {
      await db.insert(adminAuditLog).values({
        timestamp: new Date(),
        adminUserId: session.userId,
        adminEmail: session.email,
        actionType: 'DOCUMENT_TYPE_UPDATE',
        targetType: 'DOCUMENT_TYPE',
        targetId: documentTypeId,
        details: JSON.stringify({
          changedFields,
          documentTypeCode: existingDocumentType[0].code,
        }),
      });
    }

    return NextResponse.json(updated[0], { status: 200 });

  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ 
        error: 'Admin access required',
        code: 'UNAUTHORIZED' 
      }, { status: 403 });
    }
    console.error('PUT document type error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + error.message 
    }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await await requireAdmin(request);
    const session = await getSession(request);

    if (!session?.userId || !session?.email) {
      return NextResponse.json({ 
        error: 'Session information missing',
        code: 'SESSION_ERROR' 
      }, { status: 401 });
    }

    const { id } = await params;

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({ 
        error: "Valid document type ID is required",
        code: "INVALID_ID" 
      }, { status: 400 });
    }

    const documentTypeId = parseInt(id);
    const body = await request.json();

    if (!body.confirmId || body.confirmId !== documentTypeId) {
      return NextResponse.json({ 
        error: "Confirmation ID is required and must match document type ID",
        code: "CONFIRMATION_REQUIRED" 
      }, { status: 400 });
    }

    const existingDocumentType = await db.select()
      .from(documentTypes)
      .where(eq(documentTypes.id, documentTypeId))
      .limit(1);

    if (existingDocumentType.length === 0) {
      return NextResponse.json({ 
        error: "Document type not found",
        code: "NOT_FOUND" 
      }, { status: 404 });
    }

    const documentTypeCode = existingDocumentType[0].code;

    const filesUsingType = await db.select({ count: sql<number>`count(*)` })
      .from(assetFiles)
      .where(eq(assetFiles.documentType, documentTypeCode));

    const fileCount = filesUsingType[0]?.count || 0;

    if (fileCount > 0) {
      return NextResponse.json({ 
        error: `Cannot delete document type that is in use by ${fileCount} document${fileCount > 1 ? 's' : ''}`,
        code: "DOCUMENT_TYPE_IN_USE",
        fileCount 
      }, { status: 400 });
    }

    const deleted = await db.delete(documentTypes)
      .where(eq(documentTypes.id, documentTypeId))
      .returning();

    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'DOCUMENT_TYPE_DELETE',
      targetType: 'DOCUMENT_TYPE',
      targetId: documentTypeId,
      details: JSON.stringify({
        documentTypeCode,
        label: deleted[0].label,
      }),
    });

    return NextResponse.json({
      message: "Document type deleted successfully",
      deletedDocumentType: deleted[0],
    }, { status: 200 });

  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ 
        error: 'Admin access required',
        code: 'UNAUTHORIZED' 
      }, { status: 403 });
    }
    console.error('DELETE document type error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + error.message 
    }, { status: 500 });
  }
}
