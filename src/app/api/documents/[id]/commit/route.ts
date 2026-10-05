/**
 * POST /api/documents/[id]/commit
 * [id] = asset_files.id
 * Validation du document par l'utilisateur (tiroir : « Sauvegarder = valider »).
 * Lot 16b-3 : le moteur de commit historique (`document-ai/commit-engine`) est
 * supprimé — voir `services/documents/document-validation.service`. Le corps
 * (`agendaEffects`) est ignoré : l'agenda relève de T4.
 * NE MET PAS À JOUR last_analysis_at (validation ≠ analyse).
 */

import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { validateDocumentProposals } from '@/services/documents/document-validation.service';

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

    const result = await validateDocumentProposals(assetFileId, accountId);

    // Lot 16b-3 : plus d'enrichissement du bien déclenché au commit (second
    // appel modèle du moteur historique). La fiche est alimentée par la
    // réconciliation (T3) à partir des preuves écrites par l'analyse.

    // CDC Assistant §25.7, §31.7 : extraction validée, reportée sur le bien.
    await emitBusinessEvent({ type: 'DOCUMENT_UPDATED', accountId, entityId: assetFileId });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('POST /api/documents/[id]/commit error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: (error as Error).message }, { status: 500 });
  }
}
