/**
 * Public API for export templates - accessible to all authenticated users
 * This allows users to see available templates (with locks for unsubscribed users)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exportTemplates } from '@/db/schema';
import { eq, and, or, isNull } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';

export async function GET(request: NextRequest) {
  try {
    // Auth check - must be authenticated
    const session = await SessionService.getSession(request);
    if (!session) {
      return NextResponse.json(
        { error: 'Authentication required', code: 'UNAUTHORIZED' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const assetTypeId = searchParams.get('assetTypeId');
    const assetTypeSubcategoryId = searchParams.get('assetTypeSubcategoryId');
    const isActiveParam = searchParams.get('isActive');

    const conditions = [];

    // Only return active templates by default
    if (isActiveParam === null || isActiveParam === 'true') {
      conditions.push(eq(exportTemplates.isActive, true));
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
    }

    let query = db
      .select({
        id: exportTemplates.id,
        code: exportTemplates.code,
        label: exportTemplates.label,
        description: exportTemplates.description,
        category: exportTemplates.category,
        exportType: exportTemplates.exportType,
        assetTypeId: exportTemplates.assetTypeId,
        assetTypeSubcategoryId: exportTemplates.assetTypeSubcategoryId,
        isActive: exportTemplates.isActive,
        pdfmonkeyTemplateId: exportTemplates.pdfmonkeyTemplateId,
      })
      .from(exportTemplates);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const results = await query;

    return NextResponse.json(results, { status: 200 });
  } catch (error) {
    console.error('GET /api/export-templates error:', error);
    
    return NextResponse.json({
      error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
      code: 'INTERNAL_ERROR'
    }, { status: 500 });
  }
}
