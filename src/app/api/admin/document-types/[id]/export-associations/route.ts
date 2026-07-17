import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTypes, documentTypeExportAssociations, exportTemplates, adminAuditLog } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Require admin authentication
    const authResponse = await await requireAdmin(request);
    if (authResponse) return authResponse;

    // Get session for audit logging
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ 
        error: 'Authentication required',
        code: 'AUTH_REQUIRED' 
      }, { status: 401 });
    }

    // Extract and validate documentTypeId from params
    const { id } = await params;
    const documentTypeId = parseInt(id);
    
    if (!documentTypeId || isNaN(documentTypeId)) {
      return NextResponse.json({ 
        error: 'Valid document type ID is required',
        code: 'INVALID_DOCUMENT_TYPE_ID' 
      }, { status: 400 });
    }

    // Parse request body
    const body = await request.json();
    const { exportTemplateId, exportType, includeByDefault, displayOrder } = body;

    // Validate documentTypeId exists
    const docType = await db.select()
      .from(documentTypes)
      .where(eq(documentTypes.id, documentTypeId))
      .limit(1);

    if (docType.length === 0) {
      return NextResponse.json({ 
        error: 'Document type not found',
        code: 'DOCUMENT_TYPE_NOT_FOUND' 
      }, { status: 404 });
    }

    // Validate exportTemplateId if provided
    if (exportTemplateId !== undefined && exportTemplateId !== null) {
      const templateIdInt = parseInt(exportTemplateId);
      if (isNaN(templateIdInt)) {
        return NextResponse.json({ 
          error: 'Invalid export template ID',
          code: 'INVALID_EXPORT_TEMPLATE_ID' 
        }, { status: 400 });
      }

      const template = await db.select()
        .from(exportTemplates)
        .where(eq(exportTemplates.id, templateIdInt))
        .limit(1);

      if (template.length === 0) {
        return NextResponse.json({ 
          error: 'Export template not found',
          code: 'EXPORT_TEMPLATE_NOT_FOUND' 
        }, { status: 404 });
      }
    }

    // Validate exportType if provided
    if (exportType !== undefined && exportType !== null) {
      if (typeof exportType !== 'string' || exportType.trim() === '') {
        return NextResponse.json({ 
          error: 'Export type must be a non-empty string',
          code: 'INVALID_EXPORT_TYPE' 
        }, { status: 400 });
      }
    }

    // Validate includeByDefault
    const includeByDefaultValue = includeByDefault !== undefined ? Boolean(includeByDefault) : true;

    // Validate displayOrder
    let displayOrderValue = 0;
    if (displayOrder !== undefined && displayOrder !== null) {
      displayOrderValue = parseInt(displayOrder);
      if (isNaN(displayOrderValue) || displayOrderValue < 0) {
        return NextResponse.json({ 
          error: 'Display order must be a non-negative integer',
          code: 'INVALID_DISPLAY_ORDER' 
        }, { status: 400 });
      }
    }

    // Check if association already exists
    let existingAssociation = null;
    const whereConditions = [eq(documentTypeExportAssociations.documentTypeId, documentTypeId)];

    if (exportTemplateId !== undefined && exportTemplateId !== null) {
      whereConditions.push(eq(documentTypeExportAssociations.exportTemplateId, parseInt(exportTemplateId)));
    }

    if (exportType !== undefined && exportType !== null) {
      whereConditions.push(eq(documentTypeExportAssociations.exportType, exportType.trim()));
    }

    if (whereConditions.length > 1) {
      existingAssociation = await db.select()
        .from(documentTypeExportAssociations)
        .where(and(...whereConditions))
        .limit(1);
    }

    let result;
    let isUpdate = false;

    if (existingAssociation && existingAssociation.length > 0) {
      // Update existing association
      isUpdate = true;
      const updateData: any = {
        updatedAt: new Date()
      };

      if (includeByDefault !== undefined) {
        updateData.includeByDefault = includeByDefaultValue ? 1 : 0;
      }

      if (displayOrder !== undefined) {
        updateData.displayOrder = displayOrderValue;
      }

      result = await db.update(documentTypeExportAssociations)
        .set(updateData)
        .where(eq(documentTypeExportAssociations.id, existingAssociation[0].id))
        .returning();
    } else {
      // Create new association
      const insertData: any = {
        documentTypeId,
        includeByDefault: includeByDefaultValue ? 1 : 0,
        displayOrder: displayOrderValue,
        createdAt: new Date()
      };

      if (exportTemplateId !== undefined && exportTemplateId !== null) {
        insertData.exportTemplateId = parseInt(exportTemplateId);
      }

      if (exportType !== undefined && exportType !== null) {
        insertData.exportType = exportType.trim();
      }

      result = await db.insert(documentTypeExportAssociations)
        .values(insertData)
        .returning();
    }

    // Create audit log entry
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: session.userId,
      adminEmail: session.email || 'unknown',
      actionType: 'TEMPLATE_UPDATE',
      targetType: 'DOCUMENT_TYPE_EXPORT_ASSOCIATION',
      targetId: result[0].id,
      details: JSON.stringify({
        documentTypeId,
        exportTemplateId,
        exportType,
        action: isUpdate ? 'update' : 'create'
      })
    });

    return NextResponse.json(result[0], { status: isUpdate ? 200 : 201 });

  } catch (error: any) {
    console.error('POST export association error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + error.message 
    }, { status: 500 });
  }
}