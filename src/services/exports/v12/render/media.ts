/**
 * Étape `resolve_files` (§15.3) : téléchargement et contrôle des pièces et
 * photos retenues, avant tout rendu.
 *
 *  · fichier absent du stockage, sans clé ou vide     → `missing` ;
 *  · PDF chiffré                                        → `protected` ;
 *  · PDF ou image illisible                             → `corrupted`
 *    (PDF inspecté dans un worker isolé, voir `annexes.ts`) ;
 *  · fichier au-delà de `EXPORTS_MAX_FILE_BYTES`        → `too_large`.
 * Un fichier en échec est exclu partout (PDF, ZIP, listes — SEL-GEN-006,
 * ZIP-008) et la génération devient partielle (ALT-004, MSG-PREP-007).
 *
 * Mémoire : les fichiers sont écrits sur disque (répertoire de travail de la
 * génération), jamais gardés en mémoire ensemble ; les images sont
 * redimensionnées (sharp) à la taille utile du PDF, EXIF appliqué.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { workFileUrl } from '../static-assets';
import type { PlannedDocument, PlannedPhoto } from '../data/choices';
import type { ResolvedDocument, ResolvedFiles, ResolvedPhoto, FileStatus } from '../data/resolved';
import { IMAGE_FORMATS } from '../data/documents';
import { inspectPdfFile } from './annexes';

/** Taille maximale d'un fichier source (défaut 50 Mo). */
export const maxFileBytes = (): number => {
  const n = Number(process.env.EXPORTS_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
};

/** Téléchargement d'un objet vers un fichier ; `false` si absent. Lève `TooLargeError` au-delà du plafond. */
export type FetchToFile = (key: string, bucket: string | null, dest: string, maxBytes: number) => Promise<boolean>;

export class TooLargeError extends Error {}

/** Téléchargement S3 par défaut (flux → disque, plafonné). */
export const s3FetchToFile: FetchToFile = async (key, bucket, dest, maxBytes) => {
  // Client dédié avec délais (voir `storage.ts`) : un stockage muet ne bloque pas le worker.
  const [{ client: s3Client, bucket: S3_BUCKET }, { GetObjectCommand }] = await Promise.all([import('../storage').then((m) => m.exportS3()), import('@aws-sdk/client-s3')]);
  let res;
  try {
    res = await s3Client.send(new GetObjectCommand({ Bucket: bucket || S3_BUCKET, Key: key }));
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
  if (!res.Body) return false;
  if (res.ContentLength != null && res.ContentLength > maxBytes) throw new TooLargeError(`${res.ContentLength} octets`);
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) cb(new TooLargeError(`> ${maxBytes} octets`));
      else cb(null, chunk);
    },
  });
  await pipeline(res.Body as Readable, limiter, fs.createWriteStream(dest));
  return seen > 0;
};

/** Taille utile d'une image : photo de galerie / couverture, image annexée pleine page. */
const PHOTO_MAX_PX = 1600;
const ANNEX_IMAGE_MAX_PX = 2000;

async function toPrintableImage(src: string, dest: string, maxPx: number): Promise<boolean> {
  try {
    const sharp = (await import('sharp')).default;
    await sharp(src, { failOn: 'error', limitInputPixels: 100_000_000 })
      .rotate()
      .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(dest);
    return true;
  } catch {
    return false;
  }
}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);

async function fetchOne(fetchToFile: FetchToFile, key: string | null, bucket: string | null, dest: string): Promise<FileStatus> {
  if (!key || key === 'temp') return 'missing';
  try {
    const ok = await fetchToFile(key, bucket, dest, maxFileBytes());
    if (!ok) return 'missing';
    const st = await fsp.stat(dest).catch(() => null);
    return st && st.size > 0 ? 'ok' : 'missing';
  } catch (e) {
    if (e instanceof TooLargeError) return 'too_large';
    // Erreur de stockage transitoire : remontée (échec technique, retry), pas une exclusion.
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { exportErrorCode: 'FILE_UNAVAILABLE' });
  }
}

/** Exécute des tâches avec une concurrence bornée. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * Télécharge et contrôle les éléments retenus dans `workDir/files`.
 * Les erreurs de stockage transitoires lèvent (la génération échoue et peut
 * être relancée) ; un fichier absent ou illisible est seulement exclu.
 */
export async function resolveFiles(params: {
  workDir: string;
  documents: PlannedDocument[];
  photos: PlannedPhoto[];
  fetchToFile?: FetchToFile;
}): Promise<ResolvedFiles> {
  const fetchToFile = params.fetchToFile ?? s3FetchToFile;
  const dir = path.join(params.workDir, 'files');
  await fsp.mkdir(dir, { recursive: true });
  const documents = new Map<number, ResolvedDocument>();
  const photos = new Map<number, ResolvedPhoto>();

  await pool(params.documents, 3, async ({ doc, mode }) => {
    const local = path.join(dir, `doc-${doc.id}-${safeName(doc.fileName ?? 'fichier')}`);
    const status = await fetchOne(fetchToFile, doc.s3Key, doc.s3Bucket, local);
    if (status !== 'ok') { documents.set(doc.id, { id: doc.id, status, pages: null }); return; }
    const fmt = doc.format.toUpperCase();
    if (fmt === 'PDF') {
      // Inspection isolée (worker) ; stricte si la pièce est intégrée au PDF.
      const insp = await inspectPdfFile(local, { strict: mode === 'PDF' });
      documents.set(doc.id, insp.status === 'ok'
        ? { id: doc.id, status: 'ok', pages: insp.pages, localPath: local, boxes: insp.boxes }
        : { id: doc.id, status: insp.status, pages: null });
      return;
    }
    if (IMAGE_FORMATS.has(fmt) && mode === 'PDF') {
      const printable = path.join(dir, `doc-${doc.id}-print.jpg`);
      const ok = await toPrintableImage(local, printable, ANNEX_IMAGE_MAX_PX);
      documents.set(doc.id, ok
        ? { id: doc.id, status: 'ok', pages: 1, localPath: local, imageUrl: workFileUrl(params.workDir, printable) }
        : { id: doc.id, status: 'corrupted', pages: null });
      return;
    }
    // Pièce jointe au ZIP (format non contrôlable) : présente et non vide.
    documents.set(doc.id, { id: doc.id, status: 'ok', pages: null, localPath: local });
  });

  await pool(params.photos, 3, async ({ photo, mode }) => {
    const local = path.join(dir, `photo-${photo.id}-${safeName(photo.fileName ?? 'photo')}`);
    const status = await fetchOne(fetchToFile, photo.s3Key, photo.s3Bucket, local);
    if (status !== 'ok') { photos.set(photo.id, { id: photo.id, status }); return; }
    if (mode === 'ZIP') { photos.set(photo.id, { id: photo.id, status: 'ok', localPath: local }); return; }
    const printable = path.join(dir, `photo-${photo.id}-print.jpg`);
    const ok = await toPrintableImage(local, printable, PHOTO_MAX_PX);
    photos.set(photo.id, ok
      ? { id: photo.id, status: 'ok', url: workFileUrl(params.workDir, printable), localPath: local }
      : { id: photo.id, status: 'corrupted' });
  });

  return { documents, photos };
}

/** Octets d'un élément résolu (métriques, seuils). */
export async function fileSize(p: string | undefined): Promise<number> {
  if (!p) return 0;
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

