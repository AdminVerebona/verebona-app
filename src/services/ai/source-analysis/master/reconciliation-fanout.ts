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
 * portée). Lot 16b-3 : plus de drapeau `AI_RECONCILIATION_ENGINE` ni de pont
 * vers l'ancien moteur de cohérence.
 */
import { enqueueT3ForAnalyzedAsset } from '../../reconciliation/t3-queue';

export async function enqueueT3ForAffectedAssets(p: {
  accountId: number;
  userId: number;
  leadSourceId: number;
  affectedAssetIds: readonly number[];
  /** Bien déjà confié aux moteurs par `emitSourceAnalyzed` (évite le doublon d'appel). */
  documentAssetId: number | null;
}): Promise<{ enqueued: number[] }> {
  const ids = [...new Set(p.affectedAssetIds)].filter((id) => id !== p.documentAssetId);
  const enqueued: number[] = [];
  if (ids.length === 0) return { enqueued };

  for (const assetId of ids) {
    try {
      await enqueueT3ForAnalyzedAsset({ accountId: p.accountId, userId: p.userId, assetId, leadSourceId: p.leadSourceId });
      enqueued.push(assetId);
    } catch (e) {
      // Non bloquant : les preuves sont écrites ; une réconciliation de compte les reprendra.
      console.error(`[t1-master] mise en file T3 du bien ${assetId} impossible :`, (e as Error).message);
    }
  }

  if (enqueued.length === 0) {
    console.warn(`[t1-master] source ${p.leadSourceId} : biens ${ids.join(', ')} touchés sans réconciliation (mise en file en échec).`);
  }
  return { enqueued };
}

/**
 * Équipements et pièces touchés par un document (lot 18, volet R3, CDC 15
 * T1-04) : chaque cible reçoit son travail T3 ciblé — les valeurs lues pour
 * elle s'appliquent à SA fiche, jamais à celle du bien.
 */
export async function enqueueT3ForAffectedEntities(p: {
  accountId: number;
  userId: number;
  leadSourceId: number;
  targets: ReadonlyArray<{ type: 'EQUIPMENT' | 'ROOM'; id: number }>;
}): Promise<number[]> {
  if (p.targets.length === 0) return [];
  try {
    const { enqueueT3ForEntities } = await import('../../reconciliation/t3-queue');
    return await enqueueT3ForEntities({
      accountId: p.accountId, userId: p.userId, targets: [...p.targets], sourceFileId: p.leadSourceId,
      triggeredBy: 'document_analyzed',
    });
  } catch (e) {
    // Non bloquant : les preuves ciblées sont écrites ; une nouvelle analyse les reprendra.
    console.error(`[t1-master] mise en file T3 des équipements / pièces de la source ${p.leadSourceId} impossible :`, (e as Error).message);
    return [];
  }
}
