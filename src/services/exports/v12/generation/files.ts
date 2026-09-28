/**
 * Cycle de vie des fichiers générés : suppression manuelle (DRH-004) et
 * expiration à 30 jours (DRH-005/006).
 *
 * Dans les deux cas, l'entrée d'historique est CONSERVÉE (statut `deleted`
 * ou `expired`, sans clé de stockage ni lien) et les objets S3 sont supprimés :
 * directement pour une suppression manuelle (les échecs passent par la file
 * `pending_blob_deletions`), via la file pour l'expiration — purgée juste
 * après par la tâche quotidienne `daily-blob-purge` (blob-purge.service).
 */

import { db } from '@/db';
import { exportGenerations, pendingBlobDeletions } from '@/db/schema';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { exportStorageKeys } from '@/services/assets/asset-deletion.service';
import { deleteStorageObjects } from '@/services/storage/blob-purge.service';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function queueKeys(tx: Tx, keys: string[], now: Date): Promise<number> {
  if (!keys.length) return 0;
  const already = await tx.select({ storagePath: pendingBlobDeletions.storagePath }).from(pendingBlobDeletions)
    .where(and(inArray(pendingBlobDeletions.storagePath, keys), isNull(pendingBlobDeletions.processedAt)));
  const pending = new Set(already.map((r) => r.storagePath));
  const toQueue = [...new Set(keys)].filter((k) => !pending.has(k));
  if (toQueue.length) {
    await tx.insert(pendingBlobDeletions).values(toQueue.map((storagePath) => ({ fileId: null, storagePath, scheduledFor: now, createdAt: now })));
  }
  return toQueue.length;
}

/**
 * Objets envoyés par une exécution qui n'a pas pu clore la génération (bail
 * perdu, délai global dépassé, échec de `finalize_history`) : confiés à la
 * file de purge, sauf ceux que la ligne référence malgré tout (écriture
 * finalement aboutie). Les clés sont propres à l'exécution (`a{attempt}/`).
 */
export async function scheduleOrphanedOutputs(generationId: number, keys: string[], now: Date = new Date()): Promise<number> {
  if (!keys.length) return 0;
  const [row] = await db.select({ outputPayload: exportGenerations.outputPayload, fileKey: exportGenerations.fileKey })
    .from(exportGenerations).where(eq(exportGenerations.id, generationId)).limit(1);
  const referenced = new Set([...(row ? exportStorageKeys(row.outputPayload) : []), ...(row?.fileKey ? [row.fileKey] : [])]);
  const orphans = keys.filter((k) => !referenced.has(k));
  if (!orphans.length) return 0;
  return db.transaction((tx) => queueKeys(tx, orphans, now));
}

/** Suppression manuelle du fichier d'une génération (DRH-004). Idempotente. */
export async function deleteGenerationFile(generationId: number, userId: number): Promise<{ blobsDeleted: number; blobsScheduled: number }> {
  const [row] = await db.select({ outputPayload: exportGenerations.outputPayload, status: exportGenerations.status })
    .from(exportGenerations).where(eq(exportGenerations.id, generationId)).limit(1);
  if (!row || row.status === 'deleted') return { blobsDeleted: 0, blobsScheduled: 0 };
  const keys = exportStorageKeys(row.outputPayload);
  const { deleted, failed } = await deleteStorageObjects(keys);
  const now = new Date();
  await db.transaction(async (tx) => {
    await queueKeys(tx, failed, now);
    await tx.update(exportGenerations).set({
      status: 'deleted',
      deletedAt: now,
      fileKey: null,
      outputPayload: JSON.stringify({ fileDeletedAt: now.toISOString(), fileDeletedByUserId: userId }),
    }).where(eq(exportGenerations.id, generationId));
  });
  return { blobsDeleted: deleted.length, blobsScheduled: failed.length };
}

/**
 * Expiration quotidienne (DRH-005) : générations prêtes dont l'échéance est
 * passée → statut `expired`, objets confiés à la file de purge.
 */
export async function expireExportGenerations(now: Date = new Date(), batchSize = 200, maxBatches = 50): Promise<{ expired: number; blobsQueued: number }> {
  let expired = 0;
  let blobsQueued = 0;
  for (let b = 0; b < maxBatches; b++) {
    const rows = await db.select({ id: exportGenerations.id, outputPayload: exportGenerations.outputPayload })
      .from(exportGenerations)
      .where(and(
        or(eq(exportGenerations.status, 'ready'), eq(exportGenerations.status, 'partial')),
        lte(exportGenerations.expiresAt, now),
      ))
      .limit(batchSize);
    if (!rows.length) break;
    await db.transaction(async (tx) => {
      blobsQueued += await queueKeys(tx, rows.flatMap((r) => exportStorageKeys(r.outputPayload)), now);
      await tx.update(exportGenerations).set({
        status: 'expired',
        fileKey: null,
        outputPayload: JSON.stringify({ expiredAt: now.toISOString() }),
      }).where(inArray(exportGenerations.id, rows.map((r) => r.id)));
    });
    expired += rows.length;
    if (rows.length < batchSize) break;
  }
  return { expired, blobsQueued };
}
