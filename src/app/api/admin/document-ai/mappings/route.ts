/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * REFD-006 : consultation seule des mappings (Référentiels > Règles et mappings).
 * POST supprimé, ainsi que `mappings/[id]` (PATCH, DELETE).
 */
/**
 * GET  /api/admin/document-ai/mappings — Liste les mappings de taxonomie IA
 * POST /api/admin/document-ai/mappings — Crée un nouveau mapping manuellement
 * CDC §19 : "Le rattachement d'une proposition à une valeur canonique crée un mapping réutilisable."
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTaxonomyMappings } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);

    const { searchParams } = new URL(req.url);
    const mappingType = searchParams.get('type'); // 'function_code' | 'date_label' | null (all)

    let query = db.select().from(documentTaxonomyMappings).$dynamic();

    if (mappingType === 'function_code' || mappingType === 'date_label') {
      query = query.where(eq(documentTaxonomyMappings.mappingType, mappingType));
    }

    const mappings = await query.orderBy(
      desc(documentTaxonomyMappings.status),
      desc(documentTaxonomyMappings.createdAt)
    );

    return NextResponse.json({ mappings });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/admin/document-ai/mappings error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

