/**
 * retroactive-analysis.service.ts — V4 Chantier 9
 * Analyse rétroactive de tous les documents non-analysés d'un compte,
 * déclenchée lors du passage Standard → Premium via webhook Stripe.
 *
 * Traitement par batch de 5 avec throttle de 2s entre chaque batch.
 */

import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, isNull, or } from 'drizzle-orm';
import { analyzeFileSources } from '@/services/ai/source-analysis/entrypoint';

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2000;

/**
 * scheduleRetroactiveAnalysis — point d'entrée depuis le webhook Stripe.
 * Fire-and-forget : ne bloque pas la réponse webhook.
 */
export async function scheduleRetroactiveAnalysis(accountId: number): Promise<void> {
  const unanalyzed = await db.select({ id: assetFiles.id })
    .from(assetFiles)
    .where(
      and(
        eq(assetFiles.accountId, accountId),
        isNull(assetFiles.deletedAt),
        isNull(assetFiles.lastAnalysisAt),
        isNull(assetFiles.analysisState),
        or(
          eq(assetFiles.uploadStatus, 'COMPLETED'),
          isNull(assetFiles.uploadStatus)
        )
      )
    )
    .limit(200);

  if (unanalyzed.length === 0) {
    console.info(`[retroactive] Account ${accountId}: no unanalyzed files, skipping`);
    return;
  }

  console.info(`[retroactive] Account ${accountId}: scheduling ${unanalyzed.length} files in batches of ${BATCH_SIZE}`);

  // Marquer tous les fichiers comme ANALYZING dès le départ
  // (non bloquant par rapport au pipeline, juste pour l'affichage)
  for (const file of unanalyzed) {
    await db.update(assetFiles)
      .set({ analysisState: 'ANALYZING', updatedAt: new Date() })
      .where(eq(assetFiles.id, file.id));
  }

  // Traitement par batch de 5
  for (let i = 0; i < unanalyzed.length; i += BATCH_SIZE) {
    const batch = unanalyzed.slice(i, i + BATCH_SIZE);

    // Traiter le batch en parallèle (5 analyses simultanées max)
    await Promise.allSettled(
      batch.map(file =>
        analyzeFileSources([file.id], accountId, { origin: 'retroactive-analysis' }).catch(err =>
          console.error(`[retroactive] File ${file.id} failed:`, err)
        )
      )
    );

    // Throttle entre les batches (sauf le dernier)
    if (i + BATCH_SIZE < unanalyzed.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.info(`[retroactive] Account ${accountId}: retroactive analysis complete`);
}
