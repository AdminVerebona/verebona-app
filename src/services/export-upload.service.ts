/**
 * Service d'upload S3 pour les exports générés
 * Stocke dans exports/[accountId]/[assetId]/[exportId]/[filename]
 */

import { s3Client, S3_BUCKET } from '@/lib/s3-client';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

export function buildExportS3Key(
  accountId: number,
  assetId: number,
  exportId: number,
  filename: string,
): string {
  return `exports/${accountId}/${assetId}/${exportId}/${filename}`;
}

export async function uploadExportFile(
  buffer: Buffer,
  s3Key: string,
  contentType: string,
): Promise<string> {
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: contentType,
    Metadata: {
      'x-verebona-type': 'export',
    },
  }));
  return s3Key;
}

export async function getExportSignedUrl(s3Key: string, expiresInSeconds = 3600): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}
