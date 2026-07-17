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
  errors: string[];
  startedAt: string;
  completedAt: string;
  duration: number;
}

/**
 * Exécute le job de cleanup
 */
export async function runCleanupJob(): Promise<CleanupResult> {
  const startedAt = new Date();
  const startTime = Date.now();
  
  const result: CleanupResult = {
    success: true,
    filesProcessed: 0,
    filesDeletedFromS3: 0,
    filesDeletedFromDB: 0,
    errors: [],
    startedAt: startedAt.toISOString(),
    completedAt: '',
    duration: 0,
  };

  try {

    // Calculer la date limite (30 jours en arrière)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - SOFT_DELETE_RETENTION_DAYS);
    const cutoffDateISO = cutoffDate.toISOString();


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
          lt(assetFiles.deletedAt, cutoffDate)
        )
      );

    result.filesProcessed = filesToDelete.length;


    if (filesToDelete.length === 0) {
      result.completedAt = new Date().toISOString();
      result.duration = Date.now() - startTime;
      return result;
    }

    // Supprimer chaque fichier
    for (const file of filesToDelete) {
      try {
        // 1. Supprimer de S3
        try {
          const deleteCommand = new DeleteObjectCommand({
            Bucket: file.s3Bucket || bucketName,
              Key: file.s3Key ?? undefined,
          });

          await s3Client.send(deleteCommand);
          result.filesDeletedFromS3++;
          
        } catch (s3Error) {
          console.error(`[CLEANUP] Failed to delete from S3: ${file.s3Key}`, s3Error);
          result.errors.push(`S3 deletion failed for ${file.s3Key}: ${s3Error instanceof Error ? s3Error.message : 'Unknown error'}`);
          // Continue avec la suppression DB même si S3 échoue
        }

        // 2. Hard delete de la base de données
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
}> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - SOFT_DELETE_RETENTION_DAYS);
  const cutoffDateISO = cutoffDate.toISOString();

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
        lt(assetFiles.deletedAt, cutoffDate)
      )
    );

  const eligibleForCleanup = Number(eligibleResult[0]?.count || 0);
  const estimatedSpaceReclaim = Number(eligibleResult[0]?.totalSize || 0);

  return {
    totalSoftDeleted,
    eligibleForCleanup,
    estimatedSpaceReclaim,
  };
}