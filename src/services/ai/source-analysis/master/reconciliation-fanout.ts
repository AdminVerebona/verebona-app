/**
 * Réconciliation de TOUS les biens touchés par un document — CDC 15 T1-04,
 * T1-05, §3 (« Source → … → Réconciliation → État canonique »).
 *
 * Au chemin master, un document écrit des preuves sur PLUSIEURS biens (facture
 * de deux véhicules, preuves antérieures remplacées sur un autre bien). Or
 * l'abonné T3 de `emitSourceAnalyzed` ne réconcilie que le bien du document
 * (`assetId`), et rien du tout sans bien déterminé : les autres biens
 * garderaient des preuves jamais réconciliées. Chaque bien touché reçoit donc
 * son travail T3 (même déclencheur `source_analyzed`, même déduplication par
 * portée), sous le même drapeau que l'abonné.
 *
 * Même aiguillage que `emitSourceAnalyzed` (§10.4), bien par bien :
 *   · nouveau moteur autorisé (`shouldRunNewEngine`) → travail T3 en file ;
 *   · moteur historique autorisé (`shouldRunLegacy`) → même pont que
 *     l'abonné historique : `emitAssetUpdated(… 'document_analyzed')`.
 */
import { shouldRunLegacy, shouldRunNewEngine } from '../../flags/ai-feature-flags';
import { enqueueT3ForAnalyzedAsset } from '../../reconciliation/t3-queue';

export async function enqueueT3ForAffectedAssets(p: {
  accountId: number;
  userId: number;
  leadSourceId: number;
  affectedAssetIds: readonly number[];
  /** Bien déjà confié aux moteurs par `emitSourceAnalyzed` (évite le doublon d'appel). */
  documentAssetId: number | null;
}): Promise<{ enqueued: number[]; legacy: number[] }> {
  const ids = [...new Set(p.affectedAssetIds)].filter((id) => id !== p.documentAssetId);
  const enqueued: number[] = [];
  const legacy: number[] = [];
  if (ids.length === 0) return { enqueued, legacy };

  if (shouldRunNewEngine('AI_RECONCILIATION_ENGINE')) {
    for (const assetId of ids) {
      try {
        await enqueueT3ForAnalyzedAsset({ accountId: p.accountId, userId: p.userId, assetId, leadSourceId: p.leadSourceId });
        enqueued.push(assetId);
      } catch (e) {
        // Non bloquant : les preuves sont écrites ; une réconciliation de compte les reprendra.
        console.error(`[t1-master] mise en file T3 du bien ${assetId} impossible :`, (e as Error).message);
      }
    }
  }

  if (shouldRunLegacy('AI_RECONCILIATION_ENGINE')) {
    // Pont historique, identique à celui de `emitSourceAnalyzed`.
    const { emitAssetUpdated } = await import('@/services/coherence/impact-propagation.service');
    for (const assetId of ids) {
      try {
        await emitAssetUpdated(p.accountId, assetId, { _trigger: 'document_analyzed', _documentId: p.leadSourceId });
        legacy.push(assetId);
      } catch (e) {
        console.error(`[t1-master] réconciliation historique du bien ${assetId} impossible :`, (e as Error).message);
      }
    }
  }

  if (enqueued.length === 0 && legacy.length === 0) {
    console.warn(`[t1-master] source ${p.leadSourceId} : biens ${ids.join(', ')} touchés sans réconciliation (moteurs désactivés ou en échec).`);
  }
  return { enqueued, legacy };
}
