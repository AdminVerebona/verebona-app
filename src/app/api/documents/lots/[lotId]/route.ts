/**
 * GET /api/documents/lots/[lotId]
 * Retourne le lot + ses items avec leur nombre de propositions en attente.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { documentLots, documentLotItems, documentAnalysisProposals, assetFiles } from '@/db/schema';
import { eq, and, count } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ lotId: string }> }
) {
  try {
    const session = await getSession(request);
    const { lotId: rawId } = await params;
    const accountId = session.currentAccountId;

    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const lotId = parseInt(rawId);
    if (isNaN(lotId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [lot] = await db
      .select()
      .from(documentLots)
      .where(and(eq(documentLots.id, lotId), eq(documentLots.accountId, accountId)))
      .limit(1);

    if (!lot) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

    // Load items with file metadata
    const items = await db
      .select({
        id: documentLotItems.id,
        assetFileId: documentLotItems.assetFileId,
        position: documentLotItems.position,
        analysisStatus: documentLotItems.analysisStatus,
        commitStatus: documentLotItems.commitStatus,
        currentAnalysisRunId: documentLotItems.currentAnalysisRunId,
        filename: assetFiles.filename,
        originalFilename: assetFiles.originalFilename,
        mimeType: assetFiles.mimeType,
        retainedTitle: assetFiles.retainedTitle,
        retainedFunctionCode: assetFiles.retainedFunctionCode,
        assetId: assetFiles.assetId,
        linkedAssetId: assetFiles.linkedAssetId,
      })
      .from(documentLotItems)
      .leftJoin(assetFiles, eq(documentLotItems.assetFileId, assetFiles.id))
      .where(eq(documentLotItems.lotId, lotId))
      .orderBy(documentLotItems.position);

    // For each analyzed item, fetch pending proposals count
    const itemsWithProposals = await Promise.all(
      items.map(async (item) => {
        if (!item.currentAnalysisRunId) return { ...item, pendingProposalCount: 0 };

        const [{ value: pendingCount }] = await db
          .select({ value: count() })
          .from(documentAnalysisProposals)
          .where(and(
            eq(documentAnalysisProposals.runId, item.currentAnalysisRunId),
            eq(documentAnalysisProposals.status, 'pending'),
          ));

        return { ...item, pendingProposalCount: Number(pendingCount) };
      })
    );

    return NextResponse.json({ lot, items: itemsWithProposals });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/documents/lots/[lotId] error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
