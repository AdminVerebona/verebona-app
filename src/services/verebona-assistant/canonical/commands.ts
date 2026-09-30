/**
 * Même couche pour lire et pour écrire — CDC 15 T2-40 (lot 15).
 *
 * `commandAssetState` rend l'état d'un bien au format attendu par les
 * commandes (`plan.service`, `executors`) mais LU dans l'état canonique :
 * `characteristics[clé]` = valeur canonique (clé, alias ou colonne
 * historique, dans cet ordre — CanonicalAssetView), pour toutes les clés du
 * registre ; les autres entrées de la fiche restent telles quelles. La
 * valeur présentée à la confirmation (« A → B ») et la valeur relue avant
 * l'écriture sont ainsi celles que l'assistant LIT (T2-22) et que la fiche
 * affiche. Borné au compte.
 */
import { loadAssetRow, buildCanonicalAssetState, parseKc, type SqlRunner } from '@/services/canonical/asset-state';
import { pgClient } from '@/db';
import type { AssetState } from '../commands/plan.service';

export async function commandAssetState(accountId: number, assetId: number, run: SqlRunner = pgClient as unknown as SqlRunner): Promise<AssetState | null> {
  const row = await loadAssetRow(run, assetId, accountId);
  if (!row) return null;
  const state = buildCanonicalAssetState(row);
  const characteristics: Record<string, unknown> = { ...parseKc(row.key_characteristics) };
  for (const [k, f] of Object.entries(state.fields)) characteristics[k] = f.value;
  const r = row as Record<string, unknown>;
  return {
    id: Number(row.id),
    name: String(r.name ?? ''),
    city: (r.city as string | null) ?? null,
    category: row.category,
    status: (r.status as string | null) ?? null,
    lockState: (r.lock_state as string | null) ?? null,
    characteristics,
  };
}

/**
 * La valeur présentée à la confirmation est-elle toujours la valeur en
 * place ? Vrai si elle égale la valeur CANONIQUE ou, pendant la transition,
 * celle du lecteur historique des commandes (la présentation a pu en venir).
 */
export function unchangedSinceConfirmation(previous: unknown, canonical: unknown, legacy: unknown): boolean {
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return s(previous) === s(canonical) || s(previous) === s(legacy);
}
