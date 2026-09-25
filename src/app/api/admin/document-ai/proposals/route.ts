/**
 * CDC Back-Office V1 — LECTURE SEULE.
 * REFD-006 : consultation seule ; PATCH (rattachement / rejet) supprimé.
 */
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
import { documentAnalysisProposals } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
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

