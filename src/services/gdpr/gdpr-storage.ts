/**
 * Accès S3 (OVH) de l'export RGPD : lecture des documents déposés, suppression
 * des archives expirées. Isolé et importé à la demande : `@/lib/s3-client`
 * exige ses variables d'environnement dès l'import.
 */
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';

export async function downloadStoredFile(key: string, bucket?: string | null): Promise<Buffer | null> {
  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket || S3_BUCKET, Key: key }));
    if (!res.Body) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    console.error('[gdpr-storage] lecture impossible :', key, (e as Error).message);
    return null;
  }
}

export async function deleteStoredFile(key: string): Promise<boolean> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (e) {
    console.error('[gdpr-storage] suppression impossible :', key, (e as Error).message);
    return false;
  }
}
