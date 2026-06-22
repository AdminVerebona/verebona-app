import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTypes, documentTypeAssetAssociations, documentTypeExportAssociations, assetTypes, assetTypeSubcategories, adminAuditLog } from '@/db/schema';
import { eq, like, or, desc, and } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

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

export async function POST(request: NextRequest) {
  try {
    await await requireAdmin(request);
    const session = await getSession(request);

    if (!session?.userId || !session?.email) {
      return NextResponse.json({ error: 'Session information missing', code: 'SESSION_ERROR' }, { status: 401 });
    }

    const body = await request.json();
    const { code, label, description, isActive, displayOrder, assetAssociations, exportAssociations } = body;

    if (!code || typeof code !== 'string' || code.trim() === '') {
      return NextResponse.json({ error: 'Code is required and must be a non-empty string', code: 'MISSING_CODE' }, { status: 400 });
    }

    if (!label || typeof label !== 'string' || label.trim() === '') {
      return NextResponse.json({ error: 'Label is required and must be a non-empty string', code: 'MISSING_LABEL' }, { status: 400 });
    }

    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return NextResponse.json({ error: 'isActive must be a boolean', code: 'INVALID_IS_ACTIVE' }, { status: 400 });
    }

    if (displayOrder !== undefined && (typeof displayOrder !== 'number' || displayOrder < 0 || !Number.isInteger(displayOrder))) {
      return NextResponse.json({ error: 'displayOrder must be an integer >= 0', code: 'INVALID_DISPLAY_ORDER' }, { status: 400 });
    }

    const existingCode = await db.select().from(documentTypes).where(eq(documentTypes.code, code.trim())).limit(1);
    if (existingCode.length > 0) {
      return NextResponse.json({ error: 'Document type with this code already exists', code: 'DUPLICATE_CODE' }, { status: 409 });
    }

    const now = new Date();

    const newDocumentType = await db.insert(documentTypes).values({
      code: code.trim(),
      label: label.trim(),
        description: description?.trim() || null,
          isActive: isActive !== undefined ? isActive : true,
      displayOrder: displayOrder !== undefined ? displayOrder : 0,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const createdDocType = newDocumentType[0];

    if (assetAssociations && Array.isArray(assetAssociations)) {
      for (const assoc of assetAssociations) {
        if (assoc.assetTypeId) {
          const assetTypeExists = await db.select().from(assetTypes).where(eq(assetTypes.id, assoc.assetTypeId)).limit(1);
          if (assetTypeExists.length === 0) {
            return NextResponse.json({ error: `Asset type with id ${assoc.assetTypeId} not found`, code: 'ASSET_TYPE_NOT_FOUND' }, { status: 404 });
          }
        }

        if (assoc.assetTypeSubcategoryId) {
          const subcategoryExists = await db.select().from(assetTypeSubcategories).where(eq(assetTypeSubcategories.id, assoc.assetTypeSubcategoryId)).limit(1);
          if (subcategoryExists.length === 0) {
            return NextResponse.json({ error: `Asset type subcategory with id ${assoc.assetTypeSubcategoryId} not found`, code: 'SUBCATEGORY_NOT_FOUND' }, { status: 404 });
          }
        }

        await db.insert(documentTypeAssetAssociations).values({
          documentTypeId: createdDocType.id,
          assetTypeId: assoc.assetTypeId || null,
          assetTypeSubcategoryId: assoc.assetTypeSubcategoryId || null,
          isRequired: assoc.isRequired !== undefined ? assoc.isRequired : false,
          createdAt: now,
        });
      }
    }

    if (exportAssociations && Array.isArray(exportAssociations)) {
      for (const assoc of exportAssociations) {
        await db.insert(documentTypeExportAssociations).values({
          documentTypeId: createdDocType.id,
          exportType: assoc.exportType?.trim() || null,
          includeByDefault: assoc.includeByDefault !== undefined ? assoc.includeByDefault : true,
          displayOrder: assoc.displayOrder !== undefined ? assoc.displayOrder : 0,
          createdAt: now,
        });
      }
    }

    await db.insert(adminAuditLog).values({
      timestamp: now,
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'DOCUMENT_TYPE_CREATE',
      targetType: 'DOCUMENT_TYPE',
      targetId: createdDocType.id,
      details: JSON.stringify({
        code: createdDocType.code,
        label: createdDocType.label,
        assetAssociationsCount: assetAssociations?.length || 0,
        exportAssociationsCount: exportAssociations?.length || 0,
      }),
    });

    return NextResponse.json(createdDocType, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Admin access required') {
      return NextResponse.json({ error: 'Admin access required', code: 'FORBIDDEN' }, { status: 403 });
    }
    console.error('POST error:', error);
    return NextResponse.json({ error: 'Internal server error: ' + error.message }, { status: 500 });
  }
}