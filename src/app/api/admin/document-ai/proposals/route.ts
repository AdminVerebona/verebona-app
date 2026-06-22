/**
 * GET  /api/admin/document-ai/proposals
 * Retourne les propositions IA groupées + un exemple de valeur proposée.
 *
 * PATCH /api/admin/document-ai/proposals
 * action: 'accept' | 'reject'
 * - reject → bulk status='rejected' pour toutes les pending du groupe
 * - accept → bulk status='kept' + crée un documentTaxonomyMappings si pertinent
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentAnalysisProposals, documentTaxonomyMappings } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);

    // Aggregate pending proposals grouped by (targetKey, proposalType, canonicalCode, displayLabel)
    // + pick one sample proposedValueJson per group for display
    const grouped = await db
      .select({
        canonicalCode: documentAnalysisProposals.canonicalCode,
        proposalType: documentAnalysisProposals.proposalType,
        targetKey: documentAnalysisProposals.targetKey,
        displayLabel: documentAnalysisProposals.displayLabel,
        total: sql<number>`cast(count(*) as int)`,
        sampleValue: sql<string>`min(${documentAnalysisProposals.proposedValueJson})`,
        avgConfidence: sql<string>`avg(case when ${documentAnalysisProposals.confidence} is not null then cast(${documentAnalysisProposals.confidence} as float) end)::text`,
      })
      .from(documentAnalysisProposals)
      .where(eq(documentAnalysisProposals.status, 'pending'))
      .groupBy(
        documentAnalysisProposals.canonicalCode,
        documentAnalysisProposals.proposalType,
        documentAnalysisProposals.targetKey,
        documentAnalysisProposals.displayLabel,
      )
      .orderBy(sql`count(*) desc`);

    return NextResponse.json({ proposals: grouped });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof Error && ['AUTH_REQUIRED', 'INSUFFICIENT_PERMISSIONS', 'INVALID_TOKEN'].includes(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error('GET /api/admin/document-ai/proposals error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin(req);

    const body = await req.json();
    const { action, targetKey, canonicalCode, displayLabel, proposalType } = body as {
      action: 'accept' | 'reject';
      targetKey: string;
      canonicalCode: string | null;
      displayLabel: string | null;
      proposalType: string;
    };

    if (!action || !targetKey || !proposalType) {
      return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    }
    if (!['accept', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'INVALID_ACTION' }, { status: 400 });
    }

    // Build the WHERE conditions matching the group
    const conditions = [
      eq(documentAnalysisProposals.status, 'pending'),
      eq(documentAnalysisProposals.targetKey, targetKey),
      eq(documentAnalysisProposals.proposalType, proposalType),
    ];
    if (canonicalCode != null) {
      conditions.push(eq(documentAnalysisProposals.canonicalCode, canonicalCode));
    }
    if (displayLabel != null) {
      conditions.push(eq(documentAnalysisProposals.displayLabel, displayLabel));
    }

    if (action === 'reject') {
      const result = await db
        .update(documentAnalysisProposals)
        .set({ status: 'rejected' })
        .where(and(...conditions))
        .returning({ id: documentAnalysisProposals.id });

      return NextResponse.json({ ok: true, affected: result.length });
    }

    // action === 'accept'
    // 1. Bulk mark proposals as kept
    const result = await db
      .update(documentAnalysisProposals)
      .set({ status: 'kept' })
      .where(and(...conditions))
      .returning({ id: documentAnalysisProposals.id });

    // 2. Create a taxonomy mapping if relevant
    let mappingCreated = false;
    if (targetKey === 'retainedFunctionCode' && canonicalCode && displayLabel) {
      // Check not already exists
      const existing = await db
        .select({ id: documentTaxonomyMappings.id })
        .from(documentTaxonomyMappings)
        .where(and(
          eq(documentTaxonomyMappings.mappingType, 'function_code'),
          eq(documentTaxonomyMappings.canonicalCode, canonicalCode),
          eq(documentTaxonomyMappings.rawLabel, displayLabel),
        ))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(documentTaxonomyMappings).values({
          mappingType: 'function_code',
          rawLabel: displayLabel,
          canonicalCode,
          canonicalLabel: displayLabel,
          confidenceThreshold: '0.75',
          source: 'manual',
          status: 'active',
        });
        mappingCreated = true;
      }
    } else if (targetKey === 'documentDate' && proposalType === 'derived_date' && displayLabel) {
      const code = canonicalCode ?? 'DATE_DEDUITE';
      const existing = await db
        .select({ id: documentTaxonomyMappings.id })
        .from(documentTaxonomyMappings)
        .where(and(
          eq(documentTaxonomyMappings.mappingType, 'date_label'),
          eq(documentTaxonomyMappings.rawLabel, displayLabel),
        ))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(documentTaxonomyMappings).values({
          mappingType: 'date_label',
          rawLabel: displayLabel,
          canonicalCode: code,
          canonicalLabel: displayLabel,
          confidenceThreshold: '0.75',
          source: 'manual',
          status: 'active',
        });
        mappingCreated = true;
      }
    }

    return NextResponse.json({ ok: true, affected: result.length, mappingCreated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('PATCH /api/admin/document-ai/proposals error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
