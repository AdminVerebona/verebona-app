import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exportTemplates, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';

/**
 * Modèle d'export — CDC Back-Office V1 §11.1.
 *
 * EXP-007 / REC-MOD-06 : la structure (contenu, variables, catégorie…) n'est
 * pas éditable depuis le BO ; PUT et DELETE ont été supprimés.
 * EXP-003 / EXP-004 : seule l'activation globale reste, par PATCH
 * `{ isActive: boolean }`. L'effet est immédiat (le rendu filtre `isActive`)
 * et n'affecte pas les exports déjà produits (EXP-005). Journalisé (AUD-003).
 */

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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const { id } = await params;
  const templateId = Number(id);
  if (!Number.isSafeInteger(templateId) || templateId <= 0) {
    return NextResponse.json({ error: 'Valid template ID is required', code: 'INVALID_ID' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const extraFields = body ? Object.keys(body).filter((k) => k !== 'isActive') : [];
  if (!body || typeof body.isActive !== 'boolean' || extraFields.length > 0) {
    return NextResponse.json(
      {
        error: 'READ_ONLY_FIELDS',
        code: 'READ_ONLY_FIELDS',
        message: "Seule l'activation du modèle est modifiable depuis le back-office (corps attendu : { isActive: boolean }).",
        rejectedFields: extraFields,
      },
      { status: 400 },
    );
  }
  const isActive = body.isActive;

  try {
    const [current] = await db
      .select({ id: exportTemplates.id, code: exportTemplates.code, isActive: exportTemplates.isActive })
      .from(exportTemplates)
      .where(eq(exportTemplates.id, templateId))
      .limit(1);
    if (!current) {
      return NextResponse.json({ error: 'Export template not found', code: 'TEMPLATE_NOT_FOUND' }, { status: 404 });
    }

    if (current.isActive !== isActive) {
      await db
        .update(exportTemplates)
        .set({ isActive, updatedBy: adminId, updatedAt: new Date() })
        .where(eq(exportTemplates.id, templateId));
    }

    await logAdminAction({
      adminId,
      action: 'EXPORT_TEMPLATE_TOGGLE',
      targetType: 'EXPORT_TEMPLATE',
      targetId: templateId,
      result: 'SUCCESS',
      before: { isActive: current.isActive },
      after: { isActive },
      details: { code: current.code },
    });

    return NextResponse.json({ success: true, id: templateId, isActive });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('PATCH /api/admin/export-templates/[id] error:', error);
    await logAdminAction({
      adminId,
      action: 'EXPORT_TEMPLATE_TOGGLE',
      targetType: 'EXPORT_TEMPLATE',
      targetId: templateId,
      result: 'FAILURE',
      after: { isActive },
      details: { error: (error as Error).message },
    });
    return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
