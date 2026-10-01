/**
 * Parcours par lots bornés, reprenable par curseur (identifiant croissant),
 * avec pause entre lots et limite globale — commun aux étapes MIG.
 */
import type { AssetRowJson } from '@/services/canonical/asset-state';
import { pause, type StepContext } from './types';

/**
 * Parcourt des lignes par lots : `fetch(after, limit)` rend les lignes
 * d'identifiant > `after`, triées. `handle` traite un lot. Le curseur est
 * enregistré après chaque lot (reprise). Rend le nombre de lignes vues et le
 * dernier curseur.
 */
export async function iterateBatches<R extends { id: number }>(
  ctx: StepContext,
  fetch: (after: number, limit: number) => Promise<R[]>,
  handle: (rows: R[]) => Promise<void>,
  /** Partie de l'étape (curseur et limite propres) ; défaut : partie principale. */
  part?: string,
): Promise<{ scanned: number; cursor: number; exhausted: boolean }> {
  let cursor = part ? ctx.cursorOf(part) : ctx.fromCursor;
  let scanned = 0;
  for (;;) {
    const reste = ctx.limit == null ? ctx.batchSize : Math.min(ctx.batchSize, ctx.limit - scanned);
    if (reste <= 0) return { scanned, cursor, exhausted: false };
    const rows = await fetch(cursor, reste);
    if (rows.length === 0) break;
    await handle(rows);
    scanned += rows.length;
    cursor = Number(rows[rows.length - 1].id);
    await ctx.checkpoint(cursor, part);
    if (rows.length < reste) break;
    await pause(ctx.pauseMs);
  }
  return { scanned, cursor, exhausted: true };
}

/** Lignes complètes des biens (non supprimés), bornées au compte si demandé. */
export function fetchAssetRows(ctx: StepContext) {
  return async (after: number, limit: number): Promise<Array<AssetRowJson & { id: number }>> => {
    const rows = await ctx.sql<Array<{ r: AssetRowJson | string }>>`
      SELECT row_to_json(a.*) AS r FROM assets a
       WHERE a.deleted_at IS NULL AND a.account_id IS NOT NULL AND a.id > ${after}
         AND (${ctx.accountId}::int IS NULL OR a.account_id = ${ctx.accountId})
       ORDER BY a.id LIMIT ${limit}`;
    return rows.map(({ r }) => {
      const row = (typeof r === 'string' ? JSON.parse(r) : r) as AssetRowJson;
      return { ...row, id: Number(row.id) };
    });
  };
}
