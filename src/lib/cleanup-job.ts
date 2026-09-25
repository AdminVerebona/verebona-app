/**
 * Job de cleanup pour les fichiers soft-deleted
 * 
 * Supprime :
 * - Fichiers S3 pour les entrées soft-deleted depuis > 30 jours
 * - Entrées DB correspondantes (hard delete)
 * 
 * Usage :
 * - Route admin privée : POST /api/admin/cleanup
 * - Cron externe : bun run cleanup
 * - Job serverless (ex: Vercel Cron)
 */

import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { and, lt, isNotNull, sql } from 'drizzle-orm';
import { purgeEligibleCondition } from '@/services/documents/grouped-sources';

const SOFT_DELETE_RETENTION_DAYS = 30;

// S3 Client configuration
const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || 'gra',
  endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: false,
});

const bucketName = process.env.OVH_S3_BUCKET || 'verebona-files';

export interface CleanupResult {
  success: boolean;
  filesProcessed: number;
  filesDeletedFromS3: number;
  filesDeletedFromDB: number;
  /** Suppression S3 en échec : référence conservée, nouvelle tentative au prochain passage. */
  filesRetained: number;
  errors: string[];
  startedAt: string;
  completedAt: string;
  duration: number;
}

/** Suppression d'un objet S3 — injectable pour les tests. */
export type DeleteObjectFn = (bucket: string, key: string) => Promise<void>;

const defaultDeleteObject: DeleteObjectFn = async (bucket, key) => {
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};

/** Objet déjà absent du stockage : la suppression est acquise. */
function isAlreadyGone(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Exécute le job de cleanup
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JAMAIS « FICHIER DANS S3, RÉFÉRENCE SUPPRIMÉE EN BASE »
 *
 * L'enregistrement était supprimé même quand la suppression S3 échouait
 * (« Continue avec la suppression DB même si S3 échoue ») : le fichier
 * restait dans le stockage sans plus aucune référence pour le retrouver.
 *
 * Désormais, par fichier :
 *   1. suppression S3 — confirmée par S3, ou objet déjà absent ;
 *   2. SEULEMENT ALORS, suppression de l'enregistrement.
 * Échec S3 : l'enregistrement reste (deleted_at inchangé, donc toujours
 * éligible), l'échec est tracé (purge_attempts, purge_last_error,
 * purge_last_attempt_at) et la suppression reprendra au prochain passage.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function runCleanupJob(deps: { deleteObject?: DeleteObjectFn } = {}): Promise<CleanupResult> {
  const deleteObject = deps.deleteObject ?? defaultDeleteObject;
  const startedAt = new Date();
  const startTime = Date.now();
  
  const result: CleanupResult = {
    success: true,
    filesProcessed: 0,
    filesDeletedFromS3: 0,
    filesDeletedFromDB: 0,
    filesRetained: 0,
    errors: [],
    startedAt: startedAt.toISOString(),
    completedAt: '',
    duration: 0,
  };

  try {

    // Verebona Assistant — purge de l'historique conversationnel expiré (> 7 j, CDC §28.13).
    // Best-effort : ne doit jamais interrompre le cleanup S3 principal.
    try {
      const { purgeExpired } = await import('@/services/verebona-assistant/core/conversation.service');
      const purged = await purgeExpired();
      if (purged) console.log(`[CLEANUP] Verebona conversations purgées: ${purged}`);
    } catch (verebonaError) {
      console.error('[CLEANUP] Purge Verebona échouée:', verebonaError);
    }

    // Calculer la date limite (30 jours en arrière)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - SOFT_DELETE_RETENTION_DAYS);

    // Récupérer les fichiers soft-deleted depuis plus de 30 jours
    const filesToDelete = await db
      .select({
        id: assetFiles.id,
        s3Key: assetFiles.s3Key,
        s3Bucket: assetFiles.s3Bucket,
        userId: assetFiles.userId,
        assetId: assetFiles.assetId,
        filename: assetFiles.filename,
        deletedAt: assetFiles.deletedAt,
      })
      .from(assetFiles)
      .where(
        and(
          isNotNull(assetFiles.deletedAt),
          lt(assetFiles.deletedAt, cutoffDate),
          // Sources secondaires regroupées : masquées, pas supprimées. Elles
          // ne sont purgées qu'avec leur document principal (migration 0143).
          purgeEligibleCondition(cutoffDate),
        )
      );

    result.filesProcessed = filesToDelete.length;

    if (filesToDelete.length === 0) {
      result.completedAt = new Date().toISOString();
      result.duration = Date.now() - startTime;
      return result;
    }

    for (const file of filesToDelete) {
      try {
        // 1. Suppression S3 (rien à supprimer pour un lien web sans objet).
        if (file.s3Key) {
          try {
            await deleteObject(file.s3Bucket || bucketName, file.s3Key);
            result.filesDeletedFromS3++;
          } catch (s3Error) {
            if (!isAlreadyGone(s3Error)) {
              const message = s3Error instanceof Error ? s3Error.message : 'Unknown error';
              console.error(`[CLEANUP] Suppression S3 en échec, référence conservée : ${file.s3Key}`, s3Error);
              result.errors.push(`S3 deletion failed for ${file.s3Key}: ${message}`);
              result.filesRetained++;
              // Référence et statut de suppression conservés ; échec tracé.
              await db
                .update(assetFiles)
                .set({
                  purgeAttempts: sql`${assetFiles.purgeAttempts} + 1`,
                  purgeLastError: message.slice(0, 1000),
                  purgeLastAttemptAt: new Date(),
                })
                .where(sql`${assetFiles.id} = ${file.id}`);
              continue; // PAS de suppression en base
            }
            // Objet déjà absent : suppression acquise.
          }
        }

        // 2. Suppression S3 confirmée → hard delete de l'enregistrement.
        await db
          .delete(assetFiles)
          .where(sql`${assetFiles.id} = ${file.id}`);
        
        result.filesDeletedFromDB++;

      } catch (error) {
        console.error(`[CLEANUP] Error processing file ID ${file.id}:`, error);
        result.errors.push(`File ${file.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        result.success = false;
      }
    }

    // Une suppression retenue n'est pas un succès complet du passage.
    if (result.filesRetained > 0) result.success = false;

  } catch (error) {
    console.error('[CLEANUP] Fatal error during cleanup:', error);
    result.success = false;
    result.errors.push(`Fatal error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  result.completedAt = new Date().toISOString();
  result.duration = Date.now() - startTime;

  return result;
}

/**
 * Compte le nombre de fichiers éligibles au cleanup
 */
export async function getCleanupStats(): Promise<{
  totalSoftDeleted: number;
  eligibleForCleanup: number;
  estimatedSpaceReclaim: number;
  /** Fichiers dont la suppression S3 a déjà échoué au moins une fois. */
  overduePurges: number;
}> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - SOFT_DELETE_RETENTION_DAYS);

  // Total soft-deleted
  const totalSoftDeletedResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(assetFiles)
    .where(isNotNull(assetFiles.deletedAt));

  const totalSoftDeleted = Number(totalSoftDeletedResult[0]?.count || 0);

  // Éligibles au cleanup
  const eligibleResult = await db
    .select({ 
      count: sql<number>`count(*)`,
      totalSize: sql<number>`COALESCE(SUM(${assetFiles.size}), 0)`
    })
    .from(assetFiles)
    .where(
      and(
        isNotNull(assetFiles.deletedAt),
        lt(assetFiles.deletedAt, cutoffDate),
        purgeEligibleCondition(cutoffDate),
      )
    );

  const eligibleForCleanup = Number(eligibleResult[0]?.count || 0);
  const estimatedSpaceReclaim = Number(eligibleResult[0]?.totalSize || 0);

  // Suppressions en retard : au moins une tentative S3 en échec.
  const overdueResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(assetFiles)
    .where(and(isNotNull(assetFiles.deletedAt), sql`${assetFiles.purgeAttempts} > 0`));
  const overduePurges = Number(overdueResult[0]?.count || 0);

  return {
    totalSoftDeleted,
    eligibleForCleanup,
    estimatedSpaceReclaim,
    overduePurges,
  };
}