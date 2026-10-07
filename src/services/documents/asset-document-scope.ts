/**
 * Documents d'un bien — périmètre COMMUN des listes, compteurs et exports
 * (lot 32C, décision PO 9 du 07/10 : « Un document qui concerne plusieurs
 * biens doit apparaître dans les 2 listes »).
 *
 * Un document appartient à la liste d'un bien s'il lui est rattaché :
 *   · par les colonnes historiques `asset_id` / `linked_asset_id` ;
 *   · OU par un lien N-N ACTIF (`document_asset_links`, 0221) de rôle
 *     PRIMARY ou SECONDARY — toutes origines (utilisateur, analyse,
 *     migration, reflet des colonnes, pièce ou équipement du bien).
 * Un bien seulement CITÉ (MENTIONED) n'en fait PAS partie. Chaque document
 * n'apparaît qu'une fois (condition d'appartenance, jamais de jointure).
 *
 * Performance : sous-requête servie par l'index partiel 0221
 * `document_asset_links_asset_idx (asset_id, file_id) WHERE status = 'ACTIVE'`,
 * évaluée une fois (sous-plan haché) — aucun nouvel index.
 */
import { sql, type SQL } from 'drizzle-orm';
import { assetFiles } from '@/db/schema';

/** Rôles qui font figurer un document dans la liste d'un bien. */
export const ASSET_LIST_LINK_ROLES = ['PRIMARY', 'SECONDARY'] as const;

const ROLES_SQL = `('PRIMARY', 'SECONDARY')`;

/** Condition Drizzle (table `asset_files` non aliasée) : document de l'un de ces biens. */
export function documentInAssetsCondition(assetIds: readonly number[]): SQL {
  const ids = [...new Set(assetIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return sql`FALSE`;
  const liste = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  return sql`(${assetFiles.assetId} IN (${liste}) OR ${assetFiles.linkedAssetId} IN (${liste})
    OR ${assetFiles.id} IN (SELECT dal.file_id FROM document_asset_links dal
                            WHERE dal.asset_id IN (${liste}) AND dal.status = 'ACTIVE'
                              AND dal.link_role IN ${sql.raw(ROLES_SQL)}))`;
}

/** Condition Drizzle : document rattaché à AUCUN bien (ni colonne, ni lien PRIMARY / SECONDARY). */
export function documentWithoutAssetCondition(): SQL {
  return sql`(${assetFiles.assetId} IS NULL AND ${assetFiles.linkedAssetId} IS NULL
    AND NOT EXISTS (SELECT 1 FROM document_asset_links dal
                     WHERE dal.file_id = ${assetFiles.id} AND dal.status = 'ACTIVE' AND dal.asset_id IS NOT NULL
                       AND dal.link_role IN ${sql.raw(ROLES_SQL)}))`;
}

/**
 * Expression Drizzle : biens AUTRES que le bien principal (`asset_id`)
 * auxquels le document est rattaché (colonne `linked_asset_id`, liens
 * PRIMARY / SECONDARY ACTIFS vers un bien non supprimé), triés. `int[]`.
 */
export const OTHER_ASSET_IDS_SQL: SQL<number[]> = sql<number[]>`(
  SELECT COALESCE(array_agg(DISTINCT o.id ORDER BY o.id), '{}'::int[])
    FROM (
      SELECT ${assetFiles.linkedAssetId} AS id
      UNION
      SELECT dal.asset_id FROM document_asset_links dal
       WHERE dal.file_id = ${assetFiles.id} AND dal.status = 'ACTIVE' AND dal.asset_id IS NOT NULL
         AND dal.link_role IN ${sql.raw(ROLES_SQL)}
    ) o
   WHERE o.id IS NOT NULL AND o.id IS DISTINCT FROM ${assetFiles.assetId}
     AND EXISTS (SELECT 1 FROM assets x WHERE x.id = o.id AND x.account_id = ${assetFiles.accountId} AND x.deleted_at IS NULL))`;
