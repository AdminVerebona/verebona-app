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
import { isUnifiedAnalysisActive } from '@/services/ai/source-analysis/entrypoint';
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
    // ⚠️ Option A retenue : l'écran de validation disparaît, absorbé par
    // « À arbitrer » (CDC §7.1). Une fois le pipeline unifié actif, la fiche du
    // bien est alimentée par la réconciliation (usage 2) à partir des preuves,
    // et non plus par un second appel modèle déclenché au commit.
    //
    // Cette route devient alors sans objet : le pipeline écrit directement,
    // il ne reste aucune proposition en attente. `commitDocument` ci-dessus est
    // un passage à vide, conservé le temps que l'interface cesse de l'appeler.
    // Suppression prévue au lot 3, avec l'écran correspondant.
    if (resolvedAssetId && !isUnifiedAnalysisActive()) {
      const { applyAiSuggestionsToAsset } = await import('@/services/document-ai/apply-ai-suggestions');
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
