/**
 * GET /api/documents/[id]/analysis-runs
 * [id] = asset_files.id
 * Liste les runs d'analyse par ordre décroissant de started_at.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { documentAnalysisRuns } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const { id: rawId } = await params;
    const accountId = session.currentAccountId;

    if (!accountId) {
      return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });
    }

    const assetFileId = parseInt(rawId);
    if (isNaN(assetFileId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    const runs = await db
      .select()
      .from(documentAnalysisRuns)
      .where(and(
        eq(documentAnalysisRuns.assetFileId, assetFileId),
        eq(documentAnalysisRuns.accountId, accountId)
      ))
      .orderBy(desc(documentAnalysisRuns.startedAt));

    return NextResponse.json({ runs });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/documents/[id]/analysis-runs error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
