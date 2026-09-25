/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * EXP-007 / REC-MOD-06 : la structure des modèles d'export n'est pas éditable
 * depuis le BO. POST supprimé ; seule l'activation reste (`[id]` PATCH `isActive`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exportTemplates, users } from '@/db/schema';
import { eq, like, and, or, desc, gt, isNull } from 'drizzle-orm';
import { parsePaginationParams, buildPaginationResponse, getCursorId } from '@/lib/pagination';
import { requireAdmin } from '@/lib/auth-guards';

const VALID_CATEGORIES = ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'GENERAL'];

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

