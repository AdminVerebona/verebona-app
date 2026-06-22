/**
 * POST /api/documents/[id]/reset-analysis
 * Réinitialise un document bloqué en ANALYZING → ANALYSIS_FAILED
 * pour permettre une relance manuelle ou via le recovery automatique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';

export async function POST(
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

    const [file] = await db.select({ id: assetFiles.id, analysisState: assetFiles.analysisState })
      .from(assetFiles)
      .where(and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId)))
      .limit(1);

    if (!file) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    // Seulement si le document est bloqué en ANALYZING
    if (file.analysisState !== 'ANALYZING') {
      return NextResponse.json({ ok: true, state: file.analysisState, changed: false });
    }

    await db.update(assetFiles)
      .set({ analysisState: 'ANALYSIS_FAILED', analysisFailReason: 'Analyse interrompue — relancée manuellement', updatedAt: new Date() })
      .where(eq(assetFiles.id, assetFileId));

    return NextResponse.json({ ok: true, state: 'ANALYSIS_FAILED', changed: true });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('POST /api/documents/[id]/reset-analysis error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
