/**
 * Envoi S3 d'un flux texte COMPRESSÉ (gzip), en plusieurs parties, à mémoire
 * bornée — extrait de la sauvegarde quotidienne (lot 82E) pour être partagé
 * par la sauvegarde (`database-backup.service.ts`) et l'export complet de
 * recette (`admin/diagnostics-export/recette.ts`) : un seul mécanisme d'envoi.
 *
 *   · le texte est compressé au fil de l'eau ; les morceaux compressés sont
 *     accumulés jusqu'à `partSize` (S3 impose au moins 5 Mo, sauf la
 *     dernière partie) puis envoyés UN À LA FOIS, dans l'ordre ;
 *   · contre-pression : `write` attend que la compression ait de la place ET
 *     que les parties déjà produites soient envoyées — la mémoire ne grossit
 *     pas si le stockage est lent ;
 *   · `finish` termine l'envoi (l'objet n'existe qu'à cet instant) ;
 *     `abort` l'annule (aucun objet partiel visible).
 */
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';

/** Taille d'une partie envoyée (S3 impose au moins 5 Mo, sauf la dernière). */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

export interface GzipUpload {
  /** Ajoute du texte (UTF-8) ; attend la contre-pression. */
  write(text: string): Promise<void>;
  /** Termine l'envoi : octets compressés et non compressés, SHA-256 du contenu non compressé. */
  finish(): Promise<{ compressedBytes: number; bytes: number; sha256: string; parts: number }>;
  /** Annule l'envoi (sans effet si déjà terminé). */
  abort(): Promise<void>;
}

export async function openGzipUpload(
  client: Pick<S3Client, 'send'>, bucket: string, key: string,
  opts: { contentType?: string; metadata?: Record<string, string>; partSize?: number } = {},
): Promise<GzipUpload> {
  const s3 = await import('@aws-sdk/client-s3');
  const partSize = Math.max(5 * 1024 * 1024, opts.partSize ?? UPLOAD_PART_BYTES);
  const created = await client.send(new s3.CreateMultipartUploadCommand({
    Bucket: bucket, Key: key, ContentType: opts.contentType ?? 'application/gzip', ...(opts.metadata ? { Metadata: opts.metadata } : {}),
  }));
  const uploadId = (created as { UploadId?: string }).UploadId;
  if (!uploadId) throw new Error('UploadId absent');

  const parts: Array<{ ETag: string; PartNumber: number }> = [];
  let buffer: Buffer[] = [];
  let buffered = 0;
  let compressed = 0;
  let raw = 0;
  const hash = createHash('sha256');
  let chain: Promise<void> = Promise.resolve();
  let uploadError: Error | null = null;
  let done = false;

  const flush = async () => {
    if (!buffered) return;
    const body = Buffer.concat(buffer);
    buffer = [];
    buffered = 0;
    const n = parts.length + 1;
    const r = await client.send(new s3.UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n, Body: body }));
    const etag = (r as { ETag?: string }).ETag;
    if (!etag) throw new Error(`ETag absent pour la partie ${n}`);
    parts.push({ ETag: etag, PartNumber: n });
    compressed += body.length;
  };

  const gzip = createGzip({ level: 6 });
  gzip.on('data', (chunk: Buffer) => {
    buffer.push(chunk);
    buffered += chunk.length;
    if (buffered >= partSize) chain = chain.then(flush).catch((e: Error) => { uploadError = e; });
  });
  const ended = new Promise<void>((resolve, reject) => { gzip.on('end', resolve); gzip.on('error', reject); });

  const abort = async () => {
    if (done) return;
    done = true;
    gzip.destroy();
    await client.send(new s3.AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
  };

  return {
    async write(text: string) {
      if (done) throw new Error('envoi déjà terminé');
      if (uploadError) throw uploadError;
      const b = Buffer.from(text, 'utf8');
      raw += b.length;
      hash.update(b);
      if (!gzip.write(b)) await new Promise<void>((resolve) => gzip.once('drain', resolve));
      await chain;
      if (uploadError) throw uploadError;
    },
    async finish() {
      if (done) throw new Error('envoi déjà terminé');
      gzip.end();
      await ended;
      await chain;
      if (uploadError) throw uploadError;
      await flush();
      await client.send(new s3.CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
      done = true;
      return { compressedBytes: compressed, bytes: raw, sha256: hash.digest('hex'), parts: parts.length };
    },
    abort,
  };
}
