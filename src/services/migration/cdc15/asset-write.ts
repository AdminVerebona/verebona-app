/**
 * Écriture d'un plan de rattrapage sur UN bien : transaction, ligne
 * verrouillée (`SELECT … FOR UPDATE` par `writeCanonicalAssetFields`), plan
 * RECALCULÉ sur la ligne verrouillée (jamais sur une lecture antérieure),
 * `keyCharacteristics` et colonnes miroirs dans le même `UPDATE` — et la
 * COPIE RESTAURABLE de tout ce qui change (clés de fiche avec leurs
 * métadonnées, colonnes) dans la même transaction (`backup.ts`).
 * Aucun événement métier publié (rattrapage silencieux, rapport 0225).
 */
import { parseKc, writeCanonicalAssetFields, type AssetRowJson } from '@/services/canonical/asset-state';
import type { TxRunner } from '@/services/canonical/asset-state/write-canonical-asset-field';
import { assetBackupRows, writeBackups } from './backup';
import type { MigStep, StepContext } from './types';

export interface AssetPlan<E> {
  /** `keyCharacteristics` après rattrapage (null : inchangé). */
  kc: Record<string, unknown> | null;
  /** Colonnes historiques à écrire. */
  columns: Record<string, unknown>;
  entries: E[];
}

/**
 * Applique `plan(row)` au bien, sur la ligne verrouillée. Rend le plan
 * effectivement appliqué (ses entrées font foi pour le rapport), ou null si
 * le bien a disparu entre-temps.
 */
export async function applyAssetPlan<E>(
  ctx: StepContext,
  step: MigStep,
  asset: { id: number; accountId: number },
  plan: (row: AssetRowJson) => AssetPlan<E>,
): Promise<AssetPlan<E> | null> {
  let applied: AssetPlan<E> | null = null;
  const res = await writeCanonicalAssetFields(
    { assetId: asset.id, accountId: asset.accountId, origin: 'SYSTEM_RULE', mode: 'enabled', emitEvent: false, writes: [], source: { type: 'migration' } },
    {
      mutate: async ({ row, kc, tx }) => {
        const p = plan(row);
        applied = p;
        await writeBackups(tx, { runId: ctx.runId, step, accountId: asset.accountId },
          assetBackupRows(asset.id, parseKc(row.key_characteristics), p.kc, row, p.columns));
        if (p.kc) {
          for (const k of Object.keys(kc)) delete kc[k];
          Object.assign(kc, p.kc);
        }
        return p.columns;
      },
    },
    ctx.sql as unknown as TxRunner,
  );
  return res.notFound ? null : applied;
}
