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

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);

    const body = await req.json();
    const { mappingType, rawLabel, canonicalCode, canonicalLabel, confidenceThreshold } = body;

    if (!mappingType || !rawLabel || !canonicalCode || !canonicalLabel) {
      return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    }
    if (!['function_code', 'date_label'].includes(mappingType)) {
      return NextResponse.json({ error: 'INVALID_MAPPING_TYPE' }, { status: 400 });
    }

    const [created] = await db.insert(documentTaxonomyMappings).values({
      mappingType,
      rawLabel,
      canonicalCode,
      canonicalLabel,
      confidenceThreshold: confidenceThreshold ? String(confidenceThreshold) : '0.75',
      source: 'manual',
      status: 'active',
    }).returning();

    return NextResponse.json({ mapping: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('POST /api/admin/document-ai/mappings error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
