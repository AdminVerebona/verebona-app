import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exportTemplates, users, adminAuditLog } from '@/db/schema';
import { eq, like, and, or, desc, gt, isNull } from 'drizzle-orm';
import { parsePaginationParams, buildPaginationResponse, getCursorId } from '@/lib/pagination';
import { requireAdmin, getSession } from '@/lib/auth-guards';

const VALID_CATEGORIES = ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'GENERAL'];
const MAX_CODE_LENGTH = 100;
const MAX_LABEL_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 1000;

export async function GET(request: NextRequest) {
  try {
    // requireAdmin lance une erreur si pas admin, sinon retourne l'ID utilisateur
    await requireAdmin(request);

    const { searchParams } = new URL(request.url);
    const paginationParams = parsePaginationParams(searchParams);
    const category = searchParams.get('category');
    const isActiveParam = searchParams.get('isActive');
    const search = searchParams.get('search');
    const assetTypeId = searchParams.get('assetTypeId');
    const assetTypeSubcategoryId = searchParams.get('assetTypeSubcategoryId');
    const exportType = searchParams.get('exportType');

    const conditions = [];

    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return NextResponse.json({
          error: 'Invalid category value',
          code: 'INVALID_CATEGORY',
          validCategories: VALID_CATEGORIES
        }, { status: 400 });
      }
      conditions.push(eq(exportTemplates.category, category as any));
    }

    if (isActiveParam !== null) {
      const isActive = isActiveParam === 'true';
      conditions.push(eq(exportTemplates.isActive, isActive));
    }

    if (search) {
      const searchTerm = `%${search.trim()}%`;
      conditions.push(
        or(
          like(exportTemplates.code, searchTerm),
          like(exportTemplates.label, searchTerm)
        )
      );
    }

    // ✅ IMPROVED: Flexible filtering by asset type and subcategory
    // A template is visible if:
    // 1. It matches both assetTypeId AND assetTypeSubcategoryId exactly
    // 2. OR it matches assetTypeId but has no specific subcategory (null)
    // 3. OR it has no assetTypeId (generic template)
    if (assetTypeId && assetTypeId !== 'none') {
      const typeId = parseInt(assetTypeId);
      
      if (assetTypeSubcategoryId && assetTypeSubcategoryId !== 'none') {
        const subcategoryId = parseInt(assetTypeSubcategoryId);
        
          // Match exact type + subcategory, OR type + null subcategory, OR fully generic
          conditions.push(
            or(
              // Exact match: same type AND same subcategory
              and(
                eq(exportTemplates.assetTypeId, typeId),
                eq(exportTemplates.assetTypeSubcategoryId, subcategoryId)
              ),
              // Type match with no subcategory specified
              and(
                eq(exportTemplates.assetTypeId, typeId),
                isNull(exportTemplates.assetTypeSubcategoryId)
              ),
              // Fully generic template
              and(
                isNull(exportTemplates.assetTypeId),
                isNull(exportTemplates.assetTypeSubcategoryId)
              )
            )
          );
        } else {
          // Only assetTypeId provided, no subcategory
          conditions.push(
            or(
              eq(exportTemplates.assetTypeId, typeId),
              isNull(exportTemplates.assetTypeId)
            )
          );
        }
      } else if (assetTypeSubcategoryId && assetTypeSubcategoryId !== 'none') {
        // Only subcategory provided (rare case)
        conditions.push(
          or(
            eq(exportTemplates.assetTypeSubcategoryId, parseInt(assetTypeSubcategoryId)),
            isNull(exportTemplates.assetTypeSubcategoryId)
          )
        );
    }

    // ✅ NEW: Filter by export type
    if (exportType && exportType !== 'none') {
      conditions.push(eq(exportTemplates.exportType, exportType as any));
    }

    if (paginationParams.cursor) {
      const cursorId = getCursorId(paginationParams.cursor);
      if (cursorId) {
        conditions.push(gt(exportTemplates.id, cursorId));
      }
    }

    let query = db
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
        updatedBy: exportTemplates.updatedBy,
        updatedByUser: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        }
      })
      .from(exportTemplates)
      .leftJoin(users, eq(exportTemplates.updatedBy, users.id))
      .orderBy(desc(exportTemplates.id))
      .limit(paginationParams.limit + 1);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const results = await query;

    const data = results.map(row => ({
      id: row.id,
      code: row.code,
      label: row.label,
      description: row.description,
      templateContent: row.templateContent,
      variables: row.variables,
      category: row.category,
      exportType: row.exportType,
      assetTypeId: row.assetTypeId,
      assetTypeSubcategoryId: row.assetTypeSubcategoryId,
      isActive: row.isActive,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedByUser: row.updatedByUser && row.updatedByUser.id ? {
        id: row.updatedByUser.id,
        email: row.updatedByUser.email,
        firstName: row.updatedByUser.firstName,
        lastName: row.updatedByUser.lastName,
      } : null
    }));

    const response = buildPaginationResponse(data, paginationParams.limit);

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/export-templates error:', error);
    
    // Erreurs d'authentification/autorisation
    if (error instanceof Error && (
      error.message.includes('Unauthorized') || 
      error.message.includes('Forbidden') ||
      error.message.includes('Admin access required')
    )) {
      return NextResponse.json({
        error: error.message,
        code: 'AUTH_ERROR'
      }, { status: 401 });
    }
    
    return NextResponse.json({
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error')
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
      const adminUserId = await await requireAdmin(request);
    
    const session = await getSession(request);
    if (!session?.userId) {
      return NextResponse.json({
        error: 'Session user not found',
        code: 'SESSION_INVALID'
      }, { status: 401 });
    }

    const body = await request.json();
    const { 
      code, 
      label, 
      description, 
      pdfmonkeyTemplateId,
      templateContent, 
      variables, 
      category, 
      isActive, 
      version, 
      assetTypeId, 
      assetTypeSubcategoryId 
    } = body;

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return NextResponse.json({
        error: 'Code is required and must be a non-empty string',
        code: 'MISSING_CODE'
      }, { status: 400 });
    }

    if (code.trim().length > MAX_CODE_LENGTH) {
      return NextResponse.json({
        error: `Code must not exceed ${MAX_CODE_LENGTH} characters`,
        code: 'CODE_TOO_LONG'
      }, { status: 400 });
    }

    if (!label || typeof label !== 'string' || label.trim().length === 0) {
      return NextResponse.json({
        error: 'Label is required and must be a non-empty string',
        code: 'MISSING_LABEL'
      }, { status: 400 });
    }

    if (label.trim().length > MAX_LABEL_LENGTH) {
      return NextResponse.json({
        error: `Label must not exceed ${MAX_LABEL_LENGTH} characters`,
        code: 'LABEL_TOO_LONG'
      }, { status: 400 });
    }

    // ✅ NEW: Validation du pdfmonkeyTemplateId
    if (!pdfmonkeyTemplateId || typeof pdfmonkeyTemplateId !== 'string' || pdfmonkeyTemplateId.trim().length === 0) {
      return NextResponse.json({
        error: 'PDFMonkey template ID is required and must be a non-empty string',
        code: 'MISSING_PDFMONKEY_TEMPLATE_ID'
      }, { status: 400 });
    }

    // Template content is now optional since we use PDFMonkey
    // if (!templateContent || typeof templateContent !== 'string' || templateContent.trim().length === 0) {
    //   return NextResponse.json({
    //     error: 'Template content is required and must be a non-empty string',
    //     code: 'MISSING_TEMPLATE_CONTENT'
    //   }, { status: 400 });
    // }

    if (!category || !VALID_CATEGORIES.includes(category)) {
      return NextResponse.json({
        error: 'Category is required and must be one of: ' + VALID_CATEGORIES.join(', '),
        code: 'INVALID_CATEGORY',
        validCategories: VALID_CATEGORIES
      }, { status: 400 });
    }

    if (description && typeof description === 'string' && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({
        error: `Description must not exceed ${MAX_DESCRIPTION_LENGTH} characters`,
        code: 'DESCRIPTION_TOO_LONG'
      }, { status: 400 });
    }

    let parsedVariables = null;
    if (variables) {
      try {
        parsedVariables = typeof variables === 'string' ? JSON.parse(variables) : variables;
        if (!Array.isArray(parsedVariables)) {
          return NextResponse.json({
            error: 'Variables must be a valid JSON array',
            code: 'INVALID_VARIABLES_FORMAT'
          }, { status: 400 });
        }
      } catch (error) {
        return NextResponse.json({
          error: 'Variables must be a valid JSON array',
          code: 'INVALID_VARIABLES_JSON'
        }, { status: 400 });
      }
    }

    const existingTemplate = await db
      .select()
      .from(exportTemplates)
      .where(eq(exportTemplates.code, code.trim()))
      .limit(1);

    if (existingTemplate.length > 0) {
      return NextResponse.json({
        error: 'A template with this code already exists',
        code: 'DUPLICATE_CODE'
      }, { status: 409 });
    }

    const now = new Date();
    const newTemplate = await db
      .insert(exportTemplates)
      .values({
        code: code.trim(),
        label: label.trim(),
        description: description?.trim() || null,
        pdfmonkeyTemplateId: pdfmonkeyTemplateId.trim(),
        templateContent: templateContent?.trim() || '',
        variables: parsedVariables ? JSON.stringify(parsedVariables) : null,
        category: category as any,
        assetTypeId: assetTypeId && assetTypeId !== 'none' ? parseInt(assetTypeId) : null,
        assetTypeSubcategoryId: assetTypeSubcategoryId && assetTypeSubcategoryId !== 'none' ? parseInt(assetTypeSubcategoryId) : null,
        isActive: isActive !== undefined ? Boolean(isActive) : true,
        version: version !== undefined ? parseInt(String(version)) : 1,
        createdAt: now,
        updatedAt: now,
        updatedBy: adminUserId,
      })
      .returning();

    await db.insert(adminAuditLog).values({
      timestamp: now,
      adminUserId: adminUserId,
      adminEmail: session.email || 'unknown',
      actionType: 'TEMPLATE_CREATE',
      targetType: 'EXPORT_TEMPLATE',
      targetId: newTemplate[0].id,
      details: JSON.stringify({
        code: newTemplate[0].code,
        label: newTemplate[0].label,
        category: newTemplate[0].category,
        pdfmonkeyTemplateId: newTemplate[0].pdfmonkeyTemplateId,
        assetTypeId: newTemplate[0].assetTypeId,
        assetTypeSubcategoryId: newTemplate[0].assetTypeSubcategoryId,
      })
    });

    return NextResponse.json(newTemplate[0], { status: 201 });
  } catch (error) {
    console.error('POST /api/admin/export-templates error:', error);
    
    if (error instanceof Error && (
      error.message.includes('Unauthorized') || 
      error.message.includes('Forbidden') ||
      error.message.includes('Admin access required')
    )) {
      return NextResponse.json({
        error: error.message,
        code: 'AUTH_ERROR'
      }, { status: 401 });
    }
    
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return NextResponse.json({
        error: 'A template with this code already exists',
        code: 'DUPLICATE_CODE'
      }, { status: 409 });
    }

    return NextResponse.json({
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error')
    }, { status: 500 });
  }
}