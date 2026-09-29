import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvents } from '@/services/verebona-assistant/events/business-events';
import { hasProjectableKnowledge, projectDocumentKnowledgeToAsset } from '@/services/ai/knowledge/document-knowledge.service';
import { db } from '@/db';
import { assetFiles, assets } from '@/db/schema';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { analyzeFileSources } from '@/services/ai/source-analysis/entrypoint';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    const { userId } = session;
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });
    const body = await request.json();
    const { documentIds, targetAssetId } = body;

    // Validate input
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'documentIds doit être un tableau non vide' },
        { status: 400 }
      );
    }

    if (!targetAssetId || isNaN(parseInt(targetAssetId))) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'targetAssetId est requis' },
        { status: 400 }
      );
    }

    const targetAssetIdInt = parseInt(targetAssetId);

    // Verify target asset exists and belongs to the current account
    const targetAsset = await db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, targetAssetIdInt),
          eq(assets.userId, userId),
          eq(assets.accountId, accountId),
          isNull(assets.deletedAt)
        )
      )
      .limit(1);

    if (targetAsset.length === 0) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Le bien cible n\'existe pas ou ne vous appartient pas' },
        { status: 403 }
      );
    }

    // Convert to numbers and validate
    const validIds = documentIds
      .map(id => parseInt(id))
      .filter(id => !isNaN(id));

    if (validIds.length === 0) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'Aucun ID valide fourni' },
        { status: 400 }
      );
    }

    // Biens d'origine (CDC 15 T3-03 : retrait des preuves sur A avant la
    // reprojection sur B).
    const avant = await db
      .select({ id: assetFiles.id, assetId: assetFiles.assetId })
      .from(assetFiles)
      .where(and(inArray(assetFiles.id, validIds), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)));

    // Update files - only those belonging to the current account and not deleted
    const updated = await db
      .update(assetFiles)
      .set({
        assetId: targetAssetIdInt,
        updatedAt: new Date()
      })
      .where(
        and(
          inArray(assetFiles.id, validIds),
          eq(assetFiles.userId, userId),
          eq(assetFiles.accountId, accountId),
          isNull(assetFiles.deletedAt)
        )
      )
      .returning();

    // CDC 15 T3-03 : déplacement A → B — retrait des preuves portées par A,
    // réconciliation de A (T3_NEGATIVE_RECONCILIATION ; ne lève jamais).
    {
      const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');
      for (const d of updated) {
        const origine = avant.find((a) => a.id === d.id)?.assetId ?? null;
        if (origine && origine !== targetAssetIdInt) {
          await onDocumentAssetChanged({ accountId, userId, fileId: d.id, fromAssetId: origine, toAssetId: targetAssetIdInt });
        }
      }
    }

    // Re-analyser en arrière-plan les documents déjà analysés dont le bien vient de changer
    if (updated.length > 0) {
      const analysedIds = updated
        .filter(f => f.analysisState != null && f.analysisState !== 'UPLOADING' && f.analysisState !== 'UPLOADED')
        .map(f => f.id);
      for (const fileId of analysedIds) {
        // Données T1 déjà persistées : projection sur le nouveau bien, sans
        // relire le fichier. Sinon, réanalyse comme auparavant.
        const cible = updated.find(f => f.id === fileId);
        const nouveauBien = cible?.assetId ?? cible?.linkedAssetId ?? null;
        const connu = nouveauBien ? await hasProjectableKnowledge(fileId).catch(() => false) : false;
        const reanalyser = () => analyzeFileSources([fileId], accountId, {
          userId,
          billable: false,
          origin: 'documents/bulk-move',
        }).catch(err => {
          console.error(`[bulk-move] re-analyse après déplacement échouée (file ${fileId}):`, err);
        });
        if (connu && nouveauBien) {
          void projectDocumentKnowledgeToAsset({ accountId, userId, fileId, assetId: nouveauBien })
            .then((preuves) => { if (preuves === 0) void reanalyser(); })
            .catch(err => {
              console.error(`[bulk-move] projection T1 échouée (file ${fileId}):`, err);
              void reanalyser();
            });
          continue;
        }
        void reanalyser();
      }
    }

    // CDC Assistant §25.7, §31.7 : document rattaché à un autre bien.
    await emitBusinessEvents(updated.map((d) => ({ type: 'DOCUMENT_UPDATED' as const, accountId, entityId: d.id })));
    return NextResponse.json({
      success: true,
      moved: updated.length,
      targetAssetId: targetAssetIdInt,
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('POST /api/documents/bulk-move error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}
