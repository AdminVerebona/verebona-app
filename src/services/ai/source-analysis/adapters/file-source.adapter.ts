/**
 * Adaptateur fichier — CDC §4.1.5.
 *
 * Responsabilités : URL signée S3, résolution du MIME, transmission au pipeline.
 * L'upload vers la Files API du fournisseur et sa suppression sont assurés par
 * la gateway (`gemini-files.ts`), pas ici : l'adaptateur reste agnostique du
 * fournisseur.
 */
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '@/lib/s3-client';
import type { SourceAdapter, AdapterPrepareInput } from './source-adapter.port';
import type { SourceInput } from '../types';

const SIGNED_URL_TTL_SECONDS = 3600;

export class FileSourceAdapter implements SourceAdapter {
  readonly sourceType = 'file' as const;

  async prepare(input: AdapterPrepareInput): Promise<SourceInput> {
    // Contrôle d'appartenance au compte AVANT toute autre chose (§4.1.4, étape 1).
    // Filtrer ici plutôt que faire confiance à l'appelant est ce qui empêche la
    // contamination inter-comptes (§11.4).
    const rows = await db
      .select({
        id: assetFiles.id,
        mimeType: assetFiles.mimeType,
        originalFilename: assetFiles.originalFilename,
        s3Key: assetFiles.s3Key,
        s3Bucket: assetFiles.s3Bucket,
        assetId: assetFiles.assetId,
        linkedAssetId: assetFiles.linkedAssetId,
      })
      .from(assetFiles)
      .where(and(
        inArray(assetFiles.id, input.sourceIds),
        eq(assetFiles.accountId, input.accountId),
        isNull(assetFiles.deletedAt),
      ));

    if (rows.length === 0) {
      throw new Error(`[file-adapter] Aucun fichier accessible pour le compte ${input.accountId}`);
    }

    const contentUrls: string[] = [];
    const mimeTypes: string[] = [];
    const displayNames: string[] = [];
    const sourceIds: number[] = [];

    for (const row of rows) {
      if (!row.s3Key || !row.s3Bucket) continue;
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: row.s3Bucket, Key: row.s3Key }),
        { expiresIn: SIGNED_URL_TTL_SECONDS },
      );
      sourceIds.push(row.id);
      contentUrls.push(url);
      mimeTypes.push(row.mimeType ?? 'application/pdf');
      displayNames.push(row.originalFilename ?? `document-${row.id}`);
    }

    if (sourceIds.length === 0) {
      throw new Error("[file-adapter] Aucun fichier ne dispose d'un objet S3 exploitable");
    }

    return {
      sourceType: 'file',
      sourceIds,
      accountId: input.accountId,
      userId: input.userId,
      mimeTypes,
      displayNames,
      contentUrls,
      linkedAssetId: input.linkedAssetId ?? rows[0].assetId ?? rows[0].linkedAssetId ?? null,
    };
  }
}
