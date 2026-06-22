/**
 * POST /api/documents/[id]/commit
 * [id] = asset_files.id
 * Commit unitaire — même moteur que commit de lot.
 * NE MET PAS À JOUR last_analysis_at (commit ≠ analyse).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { commitDocument } from '@/services/document-ai/commit-engine';
import { applyAiSuggestionsToAsset } from '@/services/document-ai/apply-ai-suggestions';
import type { AgendaEffect } from '@/types/document-ai';

export async function POST(
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

    // Verify ownership
    const [file] = await db.select({ id: assetFiles.id }).from(assetFiles).where(
      and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId))
    ).limit(1);

    if (!file) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const agendaEffects: AgendaEffect[] = body.agendaEffects ?? [];

    const result = await commitDocument(assetFileId, accountId, agendaEffects);

    // Relire l'assetId après commit (peut avoir été mis à jour par la proposal matchedAssetId)
    const [updated] = await db.select({ assetId: assetFiles.assetId }).from(assetFiles).where(eq(assetFiles.id, assetFileId)).limit(1);
    const resolvedAssetId = updated?.assetId;
    if (resolvedAssetId) {
      applyAiSuggestionsToAsset({ assetId: resolvedAssetId, accountId, assetFileId }).catch(err =>
        console.error('[commit] applyAiSuggestionsToAsset failed (non-blocking):', err)
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('POST /api/documents/[id]/commit error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: (error as Error).message }, { status: 500 });
  }
}
