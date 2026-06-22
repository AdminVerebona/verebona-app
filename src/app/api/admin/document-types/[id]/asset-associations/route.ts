import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTypes, documentTypeAssetAssociations, assetTypes, assetTypeSubcategories, adminAuditLog } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Require admin authentication and get session for audit
    await await requireAdmin(request);
    const session = await getSession(request);

    if (!session || !session) {
      return NextResponse.json({ 
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND' 
      }, { status: 401 });
    }

    // Extract and validate documentTypeId from params
    const params = await context.params;
    const documentTypeId = params.id;

    if (!documentTypeId || isNaN(parseInt(documentTypeId))) {
      return NextResponse.json({ 
        error: 'Valid document type ID is required',
        code: 'INVALID_DOCUMENT_TYPE_ID' 
      }, { status: 400 });
    }

    const documentTypeIdNum = parseInt(documentTypeId);

    // Parse request body
    const body = await request.json();
    const { assetTypeId, assetTypeSubcategoryId, isRequired } = body;

    // Validate documentTypeId exists
    const documentType = await db.select()
      .from(documentTypes)
      .where(eq(documentTypes.id, documentTypeIdNum))
      .limit(1);

    if (documentType.length === 0) {
      return NextResponse.json({ 
        error: 'Document type not found',
        code: 'DOCUMENT_TYPE_NOT_FOUND' 
      }, { status: 404 });
    }

    // Validate assetTypeId if provided
    if (assetTypeId !== undefined && assetTypeId !== null) {
      if (isNaN(parseInt(assetTypeId))) {
        return NextResponse.json({ 
          error: 'Valid asset type ID is required',
          code: 'INVALID_ASSET_TYPE_ID' 
        }, { status: 400 });
      }

      const assetType = await db.select()
        .from(assetTypes)
        .where(eq(assetTypes.id, parseInt(assetTypeId)))
        .limit(1);

      if (assetType.length === 0) {
        return NextResponse.json({ 
          error: 'Asset type not found',
          code: 'ASSET_TYPE_NOT_FOUND' 
        }, { status: 404 });
      }
    }

    // Validate assetTypeSubcategoryId if provided
    if (assetTypeSubcategoryId !== undefined && assetTypeSubcategoryId !== null) {
      if (isNaN(parseInt(assetTypeSubcategoryId))) {
        return NextResponse.json({ 
          error: 'Valid asset type subcategory ID is required',
          code: 'INVALID_SUBCATEGORY_ID' 
        }, { status: 400 });
      }

      const subcategory = await db.select()
        .from(assetTypeSubcategories)
        .where(eq(assetTypeSubcategories.id, parseInt(assetTypeSubcategoryId)))
        .limit(1);

      if (subcategory.length === 0) {
        return NextResponse.json({ 
          error: 'Asset type subcategory not found',
          code: 'SUBCATEGORY_NOT_FOUND' 
        }, { status: 404 });
      }
    }

    // Validate isRequired is boolean if provided
    let isRequiredValue = false;
    if (isRequired !== undefined && isRequired !== null) {
      if (typeof isRequired !== 'boolean') {
        return NextResponse.json({ 
          error: 'isRequired must be a boolean',
          code: 'INVALID_IS_REQUIRED' 
        }, { status: 400 });
      }
      isRequiredValue = isRequired;
    }

    // Build where conditions for checking existing association
    const whereConditions = [
      eq(documentTypeAssetAssociations.documentTypeId, documentTypeIdNum)
    ];

    if (assetTypeId !== undefined && assetTypeId !== null) {
      whereConditions.push(eq(documentTypeAssetAssociations.assetTypeId, parseInt(assetTypeId)));
    }

    if (assetTypeSubcategoryId !== undefined && assetTypeSubcategoryId !== null) {
      whereConditions.push(eq(documentTypeAssetAssociations.assetTypeSubcategoryId, parseInt(assetTypeSubcategoryId)));
    }

    // Check if association already exists
    const existingAssociation = await db.select()
      .from(documentTypeAssetAssociations)
      .where(and(...whereConditions))
      .limit(1);

    let result;
    let actionType: 'TEMPLATE_UPDATE' | 'TEMPLATE_CREATE';
    let statusCode: number;

    if (existingAssociation.length > 0) {
      // Update existing association
      const updated = await db.update(documentTypeAssetAssociations)
        .set({
          isRequired: isRequiredValue
        })
        .where(eq(documentTypeAssetAssociations.id, existingAssociation[0].id))
        .returning();

      result = updated[0];
      actionType = 'TEMPLATE_UPDATE';
      statusCode = 200;
    } else {
      // Create new association
      const insertData: any = {
        documentTypeId: documentTypeIdNum,
        isRequired: isRequiredValue,
        createdAt: new Date()
      };

      if (assetTypeId !== undefined && assetTypeId !== null) {
        insertData.assetTypeId = parseInt(assetTypeId);
      }

      if (assetTypeSubcategoryId !== undefined && assetTypeSubcategoryId !== null) {
        insertData.assetTypeSubcategoryId = parseInt(assetTypeSubcategoryId);
      }

      const created = await db.insert(documentTypeAssetAssociations)
        .values(insertData)
        .returning();

      result = created[0];
      actionType = 'TEMPLATE_CREATE';
      statusCode = 201;
    }

    // Create audit log entry
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: actionType,
      targetType: 'DOCUMENT_TYPE_ASSOCIATION',
      targetId: result.id,
      details: JSON.stringify({
        documentTypeId: documentTypeIdNum,
        assetTypeId: assetTypeId || null,
        assetTypeSubcategoryId: assetTypeSubcategoryId || null,
        isRequired: isRequiredValue,
        operation: existingAssociation.length > 0 ? 'update' : 'create'
      })
    });

    return NextResponse.json(result, { status: statusCode });

  } catch (error: any) {
    console.error('POST error:', error);
    
    // Handle authentication errors
    if (error.message?.includes('authentication') || error.message?.includes('authorized')) {
      return NextResponse.json({ 
        error: error.message,
        code: 'AUTHENTICATION_ERROR' 
      }, { status: 401 });
    }

    return NextResponse.json({ 
      error: 'Internal server error: ' + error.message 
    }, { status: 500 });
  }
}