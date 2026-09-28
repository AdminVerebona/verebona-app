/**
 * Suppression des objets du stockage (OVH S3) et file de purge
 * `pending_blob_deletions`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE
 *
 * La file n'était traitée que par GET /api/cron/purge-blobs, qu'aucun
 * planificateur du dépôt n'appelle : sans configuration externe, rien n'était
 * jamais supprimé. Le lot de 50 était lu sans ORDER BY et une ligne en échec
 * était relue à chaque passage, indéfiniment : quelques objets impossibles à
 * supprimer pouvaient occuper tout le lot et bloquer la file.
 *
 * Désormais :
 *   · `deleteStorageObjects` supprime directement (utilisé par la suppression
 *     d'un export, DRH-004) ; seuls les objets en échec passent par la file ;
 *   · `purgePendingBlobs` traite la file dans l'ordre (`scheduled_for`, `id`),
 *     par lots successifs ; chaque échec incrémente `attempt_count` et
 *     repousse `scheduled_for` (backoff exponentiel) ; au-delà de
 *     `MAX_ATTEMPTS`, la ligne est exclue et reste pour examen ;
 *   · la purge est une tâche quotidienne interne (daily-maintenance-scheduler),
 *     la route cron restant disponible pour un déclenchement externe.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { db } from '@/db';
import { pendingBlobDeletions } from '@/db/schema';
import { and, asc, eq, isNull, lt, lte } from 'drizzle-orm';

/** Au-delà, la ligne n'est plus tentée (exclue de la file). */
export const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const MAX_BATCHES = 20;

/** Suppression d'un objet ; lève en cas d'échec autre que « déjà absent ». */
export type DeleteObjectFn = (key: string) => Promise<void>;

function isAlreadyGone(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** Suppression S3 par défaut (client applicatif, bucket OVH). */
export const defaultDeleteObject: DeleteObjectFn = async (key) => {
  const [{ s3Client, S3_BUCKET }, { DeleteObjectCommand }] = await Promise.all([
    import('@/lib/s3-client'),
    import('@aws-sdk/client-s3'),
  ]);
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } catch (error) {
    if (isAlreadyGone(error)) return;
    throw error;
  }
};

/** Délai avant la tentative suivante : 1 h, 2 h, 4 h, 8 h… */
export function backoffMs(attemptCount: number): number {
  return 2 ** Math.max(0, attemptCount - 1) * 60 * 60 * 1000;
}

/**
 * Supprime directement les objets (au mieux). Renvoie les clés dont la
 * suppression a échoué — à confier à la file par l'appelant.
 */
export async function deleteStorageObjects(
  keys: string[],
  deleteObject: DeleteObjectFn = defaultDeleteObject,
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    try {
      await deleteObject(key);
      deleted.push(key);
    } catch (error) {
      console.error(`[blob-purge] suppression directe impossible (${key}) — confiée à la file :`, error);
      failed.push(key);
    }
  }
  return { deleted, failed };
}

export interface PurgeResult {
  processed: number;
  failed: number;
  /** Lignes ayant atteint MAX_ATTEMPTS lors de ce passage (exclues). */
  abandoned: number;
}

/** Traite la file de purge, dans l'ordre, par lots, avec backoff. */
export async function purgePendingBlobs(options: {
  now?: Date;
  deleteObject?: DeleteObjectFn;
  batchSize?: number;
  maxBatches?: number;
} = {}): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const deleteObject = options.deleteObject ?? defaultDeleteObject;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MAX_BATCHES;
  const result: PurgeResult = { processed: 0, failed: 0, abandoned: 0 };

  for (let batch = 0; batch < maxBatches; batch++) {
    const pending = await db
      .select({
        id: pendingBlobDeletions.id,
        storagePath: pendingBlobDeletions.storagePath,
        attemptCount: pendingBlobDeletions.attemptCount,
      })
      .from(pendingBlobDeletions)
      .where(and(
        isNull(pendingBlobDeletions.processedAt),
        lte(pendingBlobDeletions.scheduledFor, now),
        lt(pendingBlobDeletions.attemptCount, MAX_ATTEMPTS),
      ))
      .orderBy(asc(pendingBlobDeletions.scheduledFor), asc(pendingBlobDeletions.id))
      .limit(batchSize);

    for (const item of pending) {
      try {
        await deleteObject(item.storagePath);
        await db
          .update(pendingBlobDeletions)
          .set({ processedAt: now, errorMessage: null })
          .where(eq(pendingBlobDeletions.id, item.id));
        result.processed++;
      } catch (error) {
        const attemptCount = (item.attemptCount ?? 0) + 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[blob-purge] échec ${attemptCount}/${MAX_ATTEMPTS} (${item.storagePath}) :`, message);
        // Repoussée hors de la fenêtre `now` : elle ne revient pas dans un
        // lot suivant du même passage et ne bloque plus la file.
        await db
          .update(pendingBlobDeletions)
          .set({
            attemptCount,
            errorMessage: message.slice(0, 1000),
            scheduledFor: new Date(now.getTime() + backoffMs(attemptCount)),
          })
          .where(eq(pendingBlobDeletions.id, item.id));
        result.failed++;
        if (attemptCount >= MAX_ATTEMPTS) result.abandoned++;
      }
    }

    if (pending.length < batchSize) break;
  }

  return result;
}
