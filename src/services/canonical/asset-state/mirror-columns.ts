/**
 * Colonnes miroirs d'un bien (D-10) — capture et restauration.
 *
 * Sert à l'annulation d'une commande de l'assistant (« Annuler ») : quand
 * l'écriture passe par `writeCanonicalAssetField`, une modification de la
 * fiche recopie aussi des colonnes historiques (`purchase_date`,
 * `purchase_price_cents`, `address`…). Défaire la fiche sans défaire ces
 * colonnes recréerait l'écart fiche ≠ colonne que la primitive supprime.
 */
import { listFields } from '@/services/canonical/registry';
import { loadAssetRow, type SqlRunner } from './canonical-asset-view';

/** Toutes les colonnes miroirs déclarées par le registre (noms SQL). */
export const ALL_MIRROR_COLUMNS: readonly string[] = [...new Set(
  listFields().flatMap((d) => (d.mirrorColumns ?? []).map((c) => c.column)),
)].filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));

/** Valeurs actuelles des colonnes miroirs (dates `AAAA-MM-JJ`). */
export async function readMirrorColumns(
  run: SqlRunner,
  accountId: number,
  assetId: number,
): Promise<Record<string, unknown> | null> {
  const row = await loadAssetRow(run, assetId, accountId);
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const c of ALL_MIRROR_COLUMNS) out[c] = row[c] ?? null;
  return out;
}

/** Rétablit des colonnes miroirs capturées (liste blanche du registre). */
export async function restoreMirrorColumns(
  run: SqlRunner,
  accountId: number,
  assetId: number,
  mirrors: Record<string, unknown>,
): Promise<void> {
  const cols = Object.keys(mirrors).filter((c) => ALL_MIRROR_COLUMNS.includes(c));
  if (cols.length === 0) return;
  const params: unknown[] = [assetId, accountId];
  const sets = cols.map((c) => { params.push(mirrors[c] ?? null); return `${c} = $${params.length}`; });
  await run.unsafe(
    `UPDATE assets SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2`,
    params as never[],
  );
}
