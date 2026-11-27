/**
 * Carte #849 (A2) — « Remettre en service » un bien TRANSMIS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Action DÉDIÉE (seule écriture permise sur un bien transmis, avec la
 * suppression définitive) :
 *   · contrôle ATOMIQUE du quota de biens actifs : verrou du compte
 *     (`asset-quota-lock`), décompte EN_SERVICE non supprimés, droits de
 *     l'offre (`canCreateAsset` : Standard / Premium / Duo, essai, compte
 *     restreint) ; quota plein → refus clair, rien n'est écrit ;
 *   · ligne du bien verrouillée : deux remises en service simultanées n'en
 *     font qu'une (la seconde constate « déjà en service ») — aucun doublon ;
 *   · rien n'est dupliqué ni recréé : le statut seul change. Les échéances et
 *     événements du bien réapparaissent d'eux-mêmes dans l'Agenda courant
 *     (`agenda/transmitted-scope`) ; les rappels ne couvrent que J+0 → J+7
 *     et leur dédoublonnage interdit tout rappel rétroactif ou en double ;
 *   · après commit : Opérations (cession retirée si établie par le seul
 *     statut), caches de l'assistant, cohérence T3.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { canCreateAsset } from '@/services/entitlements.service';
import { countQuotaAssetsIn, lockAssetQuota } from './asset-quota-lock';

export type AssetReactivationOutcome =
  | { ok: true; alreadyActive: boolean }
  | { ok: false; status: 404; code: 'NOT_FOUND'; message: string }
  | { ok: false; status: 403; code: string; message: string; details?: Record<string, unknown> };

export async function reactivateAsset(p: { accountId: number; userId: number | null; assetId: number }): Promise<AssetReactivationOutcome> {
  const issue = await db.transaction(async (tx): Promise<AssetReactivationOutcome> => {
    await lockAssetQuota(tx, p.accountId);
    const [bien] = (await tx.execute(sql`
      SELECT id, status FROM assets WHERE id = ${p.assetId} AND account_id = ${p.accountId} AND deleted_at IS NULL FOR UPDATE`,
    )) as unknown as Array<{ id: number; status: string }>;
    if (!bien) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Bien introuvable.' };
    if (bien.status === 'EN_SERVICE') return { ok: true, alreadyActive: true };
    const actifs = await countQuotaAssetsIn(tx, p.accountId);
    const decision = await canCreateAsset(p.accountId, actifs);
    if (!decision.allowed) {
      return {
        ok: false, status: 403, code: decision.reason ?? 'ASSET_QUOTA_REACHED',
        message: decision.reason === 'ASSET_QUOTA_REACHED'
          ? `${decision.message ?? 'Quota de biens atteint.'} Ce bien reste transmis et consultable : supprimez ou transmettez un autre bien, ou choisissez une offre supérieure, pour le remettre en service.`
          : (decision.message ?? 'Remise en service impossible.'),
        details: { current_count: actifs, max_assets: decision.limit },
      };
    }
    await tx.execute(sql`UPDATE assets SET status = 'EN_SERVICE', updated_at = now() WHERE id = ${p.assetId}`);
    return { ok: true, alreadyActive: false };
  });
  if (issue.ok && !issue.alreadyActive) {
    try {
      const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
      await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: p.accountId, entityId: p.assetId });
      const { notifyOperationsEvent } = await import('@/services/business-operations/consolidation/queue');
      notifyOperationsEvent(p.accountId, { trigger: 'asset_updated', assetId: p.assetId });
      const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
      notifyCoherenceEvent(p.accountId, { event: 'asset_updated', objectType: 'asset', objectId: p.assetId });
    } catch (e) {
      console.error(`[asset-reactivation] bien ${p.assetId} : notifications après commit en échec :`, (e as Error).message);
    }
  }
  return issue;
}
