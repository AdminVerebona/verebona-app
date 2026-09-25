/**
 * Sources secondaires regroupées dans un document logique (migration 0143).
 *
 * Une source secondaire n'est PAS supprimée : elle est rattachée à la source
 * principale. `deleted_at` est posé pour la masquer des listes de documents
 * autonomes, mais le regroupement (`grouped_into_file_id`) la protège du
 * cleanup physique et la garde consultable depuis les preuves du document.
 */
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

type Tx = Pick<typeof db, 'update'>;

/** Rattache les sources secondaires à la source principale d'un document. */
export async function markSourcesGrouped(
  leadFileId: number,
  secondaryIds: number[],
  client: Tx = db,
): Promise<void> {
  const ids = secondaryIds.filter((id) => id !== leadFileId);
  if (ids.length === 0) return;
  const now = new Date();
  await client
    .update(assetFiles)
    .set({ groupedIntoFileId: leadFileId, groupedAt: now, deletedAt: now })
    .where(and(inArray(assetFiles.id, ids), ne(assetFiles.id, leadFileId)));
}

/**
 * Condition SQL « fichier réellement éligible à la suppression physique » :
 * supprimé, et soit non regroupé, soit dont le document principal est
 * lui-même supprimé depuis plus que la rétention (ou n'existe plus).
 */
export function purgeEligibleCondition(cutoff: Date) {
  return sql`(
    ${assetFiles.groupedIntoFileId} IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM asset_files lead
       WHERE lead.id = ${assetFiles.groupedIntoFileId}
         AND (lead.deleted_at IS NULL OR lead.deleted_at >= ${cutoff.toISOString()}::timestamptz)
    )
  )`;
}

/**
 * Condition SQL « fichier consultable » : non supprimé, ou source secondaire
 * d'un document principal non supprimé.
 */
export const viewableFileCondition = sql`(
  ${assetFiles.deletedAt} IS NULL
  OR (
    ${assetFiles.groupedIntoFileId} IS NOT NULL
    AND EXISTS (SELECT 1 FROM asset_files lead WHERE lead.id = ${assetFiles.groupedIntoFileId} AND lead.deleted_at IS NULL)
  )
)`;

/** Sources secondaires d'un document, pour les preuves. */
export async function listGroupedSources(leadFileId: number, accountId: number) {
  return db
    .select({ id: assetFiles.id, originalFilename: assetFiles.originalFilename, mimeType: assetFiles.mimeType, groupedAt: assetFiles.groupedAt })
    .from(assetFiles)
    .where(and(eq(assetFiles.groupedIntoFileId, leadFileId), eq(assetFiles.accountId, accountId)));
}

