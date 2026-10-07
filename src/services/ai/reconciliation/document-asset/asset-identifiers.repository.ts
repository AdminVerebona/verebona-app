/**
 * Lecture des identifiants canoniques des biens d'un compte (lot 31B).
 *
 * Source : la fiche canonique (`readCanonicalValue` — `key_characteristics`,
 * alias historiques, colonnes miroirs `address`, `postal_code`, `city`,
 * `registration_number`), jamais une colonne lue en direct : un identifiant
 * saisi dans la fiche, importé ou repris par la migration CDC 15 est vu de
 * la même façon par T1, T3 et l'assistant.
 *
 * Les valeurs SENSIBLES (adresse) sont lues : la correspondance d'adresse
 * est faite côté serveur. Elles ne sortent de ce module que vers
 * `resolveAssetByIdentifiers` ; tout ce qui part vers un modèle passe par
 * `promptIdentifiers` (filtre `sensitive` du registre).
 */
import { pgClient } from '@/db';
import { readCanonicalValue, rowFamily, type AssetRowJson } from '@/services/canonical/asset-state/canonical-asset-view';
import { IDENTIFIER_KEYS, type AssetIdentifierRecord } from './identifiers';

/** Même borne que le contexte T1 (`loadAnalysisContext`). */
export const MAX_ASSETS_FOR_IDENTIFIERS = 200;

/** Identifiants d'une ligne de bien (pure). */
export function identifierRecordOf(row: AssetRowJson): AssetIdentifierRecord {
  // Famille du registre ; OBJECT à défaut, comme la fiche (`rowFamily`).
  const family = rowFamily(row.category);
  const values: Record<string, string> = {};
  for (const key of IDENTIFIER_KEYS[family]) {
    const st = readCanonicalValue(row, key);
    const v = st?.value;
    if (v === null || v === undefined || typeof v === 'object') continue;
    const s = String(v).trim();
    if (s) values[key] = s.slice(0, 300);
  }
  return { assetId: Number(row.id), family, values };
}

/**
 * Identifiants des biens actifs du compte (`assetIds` : restreindre à ces
 * biens). Borné ; ordre stable par identifiant.
 */
export async function loadAssetIdentifiers(
  accountId: number,
  assetIds?: number[],
): Promise<AssetIdentifierRecord[]> {
  if (assetIds && assetIds.length === 0) return [];
  const rows = (await pgClient.unsafe(
    `SELECT row_to_json(a.*) AS r FROM assets a
      WHERE a.account_id = $1 AND a.deleted_at IS NULL
        AND ($2::int[] IS NULL OR a.id = ANY($2::int[]))
      ORDER BY a.id LIMIT ${MAX_ASSETS_FOR_IDENTIFIERS}`,
    [accountId, assetIds ?? null] as never[],
  )) as unknown as Array<{ r: AssetRowJson | string }>;
  return rows.map(({ r }) => identifierRecordOf(typeof r === 'string' ? JSON.parse(r) as AssetRowJson : r));
}
