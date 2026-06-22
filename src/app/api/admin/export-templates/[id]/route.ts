import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exportTemplates, users, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

const VALID_CATEGORIES = [
  'IMMOBILIER',
  'VEHICULE',
  'MATERIEL_PRO',
  'GENERAL'
] as const;

const VALID_EXPORT_TYPES = [
  'DOSSIER_VENTE',
  'ASSURANCE_DEVIS',
  'ASSURANCE_SINISTRE',
  'CIL',
  'DOSSIER_COMPLET',
  'REVENTE',
  'SAV_GARANTIE',
  'AUTRE'
] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
    try {
      await await requireAdmin(request);


    const { id } = await params;
    
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid template ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const templateId = parseInt(id);

    const result = await db
      .select({
        id: exportTemplates.id,
        code: exportTemplates.code,
        label: exportTemplates.label,
        description: exportTemplates.description,
        templateContent: exportTemplates.templateContent,
        variables: exportTemplates.variables,
        category: exportTemplates.category,
        exportType: exportTemplates.exportType,
        assetTypeId: exportTemplates.assetTypeId,
        assetTypeSubcategoryId: exportTemplates.assetTypeSubcategoryId,
        isActive: exportTemplates.isActive,
        version: exportTemplates.version,
        createdAt: exportTemplates.createdAt,
        updatedAt: exportTemplates.updatedAt,
        updatedByUserId: users.id,
        updatedByEmail: users.email,
        updatedByFirstName: users.firstName,
        updatedByLastName: users.lastName,
      })
      .from(exportTemplates)
      .leftJoin(users, eq(exportTemplates.updatedBy, users.id))
      .where(eq(exportTemplates.id, templateId))
      .limit(1);

    if (result.length === 0) {
      return NextResponse.json(
        { error: 'Export template not found', code: 'TEMPLATE_NOT_FOUND' },
        { status: 404 }
      );
    }

    const template = result[0];

    const response = {
      id: template.id,
      code: template.code,
      label: template.label,
      description: template.description,
      templateContent: template.templateContent,
      variables: template.variables,
      category: template.category,
      exportType: template.exportType,
      assetTypeId: template.assetTypeId,
      assetTypeSubcategoryId: template.assetTypeSubcategoryId,
      isActive: template.isActive,
      version: template.version,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
      updatedByUser: template.updatedByUserId
        ? {
            id: template.updatedByUserId,
            email: template.updatedByEmail,
            firstName: template.updatedByFirstName,
            lastName: template.updatedByLastName,
          }
        : null,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('GET export template error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
    try {
      await await requireAdmin(request);


    const session = await getSession(request);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found', code: 'NO_SESSION' },
        { status: 401 }
      );
    }

    const { id } = await params;
    
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid template ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const templateId = parseInt(id);

    const existingTemplate = await db
      .select()
      .from(exportTemplates)
      .where(eq(exportTemplates.id, templateId))
      .limit(1);

    if (existingTemplate.length === 0) {
      return NextResponse.json(
        { error: 'Export template not found', code: 'TEMPLATE_NOT_FOUND' },
        { status: 404 }
      );
    }

    const currentTemplate = existingTemplate[0];
    const body = await request.json();

    const {
      label,
      description,
      pdfmonkeyTemplateId,
      templateContent,
      variables,
      category,
      exportType,
      isActive,
      assetTypeId,
      assetTypeSubcategoryId,
    } = body;

    if (body.code !== undefined) {
      return NextResponse.json(
        { error: 'Template code cannot be updated', code: 'CODE_IMMUTABLE' },
        { status: 400 }
      );
    }

    if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
      return NextResponse.json(
        { 
          error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
          code: 'INVALID_CATEGORY'
        },
        { status: 400 }
      );
    }

    if (exportType !== undefined && exportType !== null && !VALID_EXPORT_TYPES.includes(exportType)) {
      return NextResponse.json(
        { 
          error: `Invalid export type. Must be one of: ${VALID_EXPORT_TYPES.join(', ')}`,
          code: 'INVALID_EXPORT_TYPE'
        },
        { status: 400 }
      );
    }

    if (variables !== undefined) {
      try {
        const parsedVariables = JSON.parse(variables);
        if (!Array.isArray(parsedVariables)) {
          return NextResponse.json(
            { error: 'Variables must be a JSON array', code: 'INVALID_VARIABLES_FORMAT' },
            { status: 400 }
          );
        }
      } catch {
        return NextResponse.json(
          { error: 'Variables must be valid JSON', code: 'INVALID_VARIABLES_JSON' },
          { status: 400 }
        );
      }
    }

    const previousValues: Record<string, any> = {};
    const newValues: Record<string, any> = {};
    const updatedFields: string[] = [];

    const updateData: Partial<typeof exportTemplates.$inferInsert> = {
      updatedAt: new Date(),
      updatedBy: session.userId,
      version: currentTemplate.version + 1,
    };

    if (label !== undefined && label !== currentTemplate.label) {
      const trimmedLabel = label.trim();
      if (!trimmedLabel) {
        return NextResponse.json(
          { error: 'Label cannot be empty', code: 'EMPTY_LABEL' },
          { status: 400 }
        );
      }
      updateData.label = trimmedLabel;
      previousValues.label = currentTemplate.label;
      newValues.label = trimmedLabel;
      updatedFields.push('label');
    }

    if (description !== undefined && description !== currentTemplate.description) {
      updateData.description = description?.trim() || null;
      previousValues.description = currentTemplate.description;
      newValues.description = updateData.description;
      updatedFields.push('description');
    }

    if (pdfmonkeyTemplateId !== undefined && pdfmonkeyTemplateId !== currentTemplate.pdfmonkeyTemplateId) {
      const trimmedId = pdfmonkeyTemplateId.trim();
      if (!trimmedId) {
        return NextResponse.json(
          { error: 'PDFMonkey template ID cannot be empty', code: 'EMPTY_PDFMONKEY_TEMPLATE_ID' },
          { status: 400 }
        );
      }
      updateData.pdfmonkeyTemplateId = trimmedId;
      previousValues.pdfmonkeyTemplateId = currentTemplate.pdfmonkeyTemplateId;
      newValues.pdfmonkeyTemplateId = trimmedId;
      updatedFields.push('pdfmonkeyTemplateId');
    }

    if (templateContent !== undefined && templateContent !== currentTemplate.templateContent) {
      updateData.templateContent = templateContent?.trim() || '';
      previousValues.templateContent = currentTemplate.templateContent;
      newValues.templateContent = updateData.templateContent;
      updatedFields.push('templateContent');
    }

    if (variables !== undefined && variables !== currentTemplate.variables) {
      updateData.variables = variables;
      previousValues.variables = currentTemplate.variables;
      newValues.variables = variables;
      updatedFields.push('variables');
    }

    if (category !== undefined && category !== currentTemplate.category) {
      updateData.category = category;
      previousValues.category = currentTemplate.category;
      newValues.category = category;
      updatedFields.push('category');
    }

    if (exportType !== undefined && exportType !== currentTemplate.exportType) {
      updateData.exportType = exportType || null;
      previousValues.exportType = currentTemplate.exportType;
      newValues.exportType = exportType || null;
      updatedFields.push('exportType');
    }

    if (isActive !== undefined && isActive !== currentTemplate.isActive) {
      updateData.isActive = isActive;
      previousValues.isActive = currentTemplate.isActive;
      newValues.isActive = isActive;
      updatedFields.push('isActive');
    }

    if (assetTypeId !== undefined) {
      const newAssetTypeId = assetTypeId && assetTypeId !== 'none' ? parseInt(assetTypeId) : null;
      if (newAssetTypeId !== currentTemplate.assetTypeId) {
        updateData.assetTypeId = newAssetTypeId;
        previousValues.assetTypeId = currentTemplate.assetTypeId;
        newValues.assetTypeId = newAssetTypeId;
        updatedFields.push('assetTypeId');
      }
    }

    if (assetTypeSubcategoryId !== undefined) {
      const newSubcategoryId = assetTypeSubcategoryId && assetTypeSubcategoryId !== 'none' ? parseInt(assetTypeSubcategoryId) : null;
      if (newSubcategoryId !== currentTemplate.assetTypeSubcategoryId) {
        updateData.assetTypeSubcategoryId = newSubcategoryId;
        previousValues.assetTypeSubcategoryId = currentTemplate.assetTypeSubcategoryId;
        newValues.assetTypeSubcategoryId = newSubcategoryId;
        updatedFields.push('assetTypeSubcategoryId');
      }
    }

    if (updatedFields.length === 0 && body.version === undefined) {
      return NextResponse.json(
        { error: 'No fields to update', code: 'NO_CHANGES' },
        { status: 400 }
      );
    }

    const updated = await db
      .update(exportTemplates)
      .set(updateData)
      .where(eq(exportTemplates.id, templateId))
      .returning();

    if (updated.length === 0) {
      return NextResponse.json(
        { error: 'Failed to update template', code: 'UPDATE_FAILED' },
        { status: 500 }
      );
    }

    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'TEMPLATE_UPDATE',
      targetType: 'EXPORT_TEMPLATE',
      targetId: templateId,
      details: JSON.stringify({
        updatedFields,
        previousValues,
        newValues,
        version: updated[0].version,
      }),
    });

    return NextResponse.json(updated[0]);
  } catch (error) {
    console.error('PUT export template error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
    try {
      await await requireAdmin(request);


    const session = await getSession(request);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found', code: 'NO_SESSION' },
        { status: 401 }
      );
    }

    const { id } = await params;
    
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid template ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const templateId = parseInt(id);

    const existingTemplate = await db
      .select()
      .from(exportTemplates)
      .where(eq(exportTemplates.id, templateId))
      .limit(1);

    if (existingTemplate.length === 0) {
      return NextResponse.json(
        { error: 'Export template not found', code: 'TEMPLATE_NOT_FOUND' },
        { status: 404 }
      );
    }

    const template = existingTemplate[0];

    const body = await request.json();
    const { confirmId } = body;

    if (!confirmId || parseInt(confirmId) !== templateId) {
      return NextResponse.json(
        { 
          error: 'Confirmation ID does not match template ID',
          code: 'CONFIRM_ID_MISMATCH'
        },
        { status: 400 }
      );
    }

    const deleted = await db
      .delete(exportTemplates)
      .where(eq(exportTemplates.id, templateId))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: 'Failed to delete template', code: 'DELETE_FAILED' },
        { status: 500 }
      );
    }

    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: session.userId,
      adminEmail: session.email,
      actionType: 'TEMPLATE_DELETE',
      targetType: 'EXPORT_TEMPLATE',
      targetId: templateId,
      details: JSON.stringify({
        code: template.code,
        label: template.label,
        category: template.category,
      }),
    });

    return NextResponse.json({
      success: true,
      message: 'Export template deleted successfully',
      deletedTemplate: {
        id: deleted[0].id,
        code: deleted[0].code,
        label: deleted[0].label,
        category: deleted[0].category,
      },
    });
  } catch (error) {
    console.error('DELETE export template error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}