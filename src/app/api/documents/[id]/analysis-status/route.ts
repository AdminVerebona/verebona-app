/**
 * GET /api/documents/[id]/analysis-status
 * Returns the current analysis run status and pending proposal count for a file.
 * Used by background polling after the upload drawer is dismissed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles, documentAnalysisRuns, documentAnalysisProposals } from '@/db/schema';
import { eq, and, count } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const { id: rawId } = await params;
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const assetFileId = parseInt(rawId);
    if (isNaN(assetFileId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [file] = await db.select({ id: assetFiles.id, analysisState: assetFiles.analysisState })
      .from(assetFiles)
      .where(and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId)))
      .limit(1);
    if (!file) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

    const [run] = await db.select({ status: documentAnalysisRuns.status })
      .from(documentAnalysisRuns)
      .where(and(
        eq(documentAnalysisRuns.assetFileId, assetFileId),
        eq(documentAnalysisRuns.isCurrentReference, true),
      ))
      .limit(1);

    // Also check for any in-progress run (isCurrentReference is false while analyzing)
    const [analyzing] = !run ? await db.select({ status: documentAnalysisRuns.status })
      .from(documentAnalysisRuns)
      .where(and(
        eq(documentAnalysisRuns.assetFileId, assetFileId),
        eq(documentAnalysisRuns.status, 'analyzing'),
      ))
      .limit(1) : [null];

    const status = run?.status ?? analyzing?.status ?? 'pending';

    let proposalCount = 0;
    if (status === 'completed') {
      const [cnt] = await db.select({ count: count() })
        .from(documentAnalysisProposals)
        .where(and(
          eq(documentAnalysisProposals.assetFileId, assetFileId),
          eq(documentAnalysisProposals.status, 'pending'),
        ));
      proposalCount = Number(cnt?.count ?? 0);
    }

    return NextResponse.json({
      status,
      proposalCount,
      analysisState: file?.analysisState ?? null
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/documents/[id]/analysis-status error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
