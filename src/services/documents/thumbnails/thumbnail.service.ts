/**
 * Génération et conservation des miniatures de documents, hors du navigateur
 * et hors de la requête interactive (APP-PERF-06 images, APP-PERF-27 PDF).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE GÉNÉRATION PAR VERSION, PARTAGÉE PAR TOUS LES APPAREILS
 *
 *   · déclenchement : après confirmation du dépôt (`/api/files/confirm`),
 *     à la première demande d'une miniature absente (rattrapage paresseux des
 *     documents existants) et par le rattrapage borné `runThumbnailBackfill` ;
 *   · file EN MÉMOIRE par instance, bornée (taille et parallélisme), sans
 *     appel IA : elle ne partage rien avec la file d'analyse T1 et ne la
 *     retarde pas ; une file pleine ignore la demande (le rattrapage la
 *     reprendra) ;
 *   · idempotence entre instances : « réservation » atomique en base
 *     (`claimThumbnail` : INSERT … ON CONFLICT … WHERE) avec bail
 *     (`lease_until`) — une génération interrompue est reprise après
 *     expiration du bail, jamais deux à la fois ; l'écriture finale est
 *     conditionnée à la même version source et au même numéro de tentative ;
 *   · bornes : taille des originaux, pixels, durée et mémoire du rendu PDF
 *     (processus enfant), tentatives par version (`THUMBNAIL_MAX_ATTEMPTS`) ;
 *   · la miniature n'est JAMAIS requise pour confirmer ou consulter un
 *     document : en attente ou en échec, l'interface affiche un placeholder
 *     (ou, pour un PDF, le rendu navigateur borné).
 *
 * L'original n'est jamais modifié : le dérivé est un nouvel objet sous
 * `derivatives/thumbnails/…` (bucket canonique, non décompté du quota).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles, assetFileThumbnails } from '@/db/schema';
import { classifyS3Error, getS3Bucket, getS3Client } from '@/lib/s3-config';
import {
  documentThumbnailKey,
  IMAGE_MAX_INPUT_PIXELS,
  IMAGE_MAX_SOURCE_BYTES,
  PDF_MAX_SOURCE_BYTES,
  THUMBNAIL_FALLBACK_QUALITY,
  THUMBNAIL_FORMAT,
  THUMBNAIL_LEASE_MS,
  THUMBNAIL_MAX_ATTEMPTS,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_QUALITY,
  THUMBNAIL_RETRY_DELAY_MS,
  THUMBNAIL_VARIANT,
  thumbnailSourceKind,
  type ThumbnailSourceKind,
} from './thumbnail-spec';
import { PdfRenderError, renderPdfFirstPage } from './pdf-render';

// ── Activation progressive ────────────────────────────────────────────────

/** `THUMBNAILS_ENABLED=false` : retour arrière (ni génération ni service). */
export function thumbnailsEnabled(): boolean {
  return !['0', 'false', 'off', 'no'].includes((process.env.THUMBNAILS_ENABLED ?? '').trim().toLowerCase());
}

function concurrency(): number {
  const n = Number(process.env.THUMBNAILS_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1;
}

const MAX_QUEUE = 200;

// ── Conversion d'image (pure, testée) ─────────────────────────────────────

export interface EncodedThumbnail {
  body: Buffer;
  width: number;
  height: number;
  format: typeof THUMBNAIL_FORMAT;
}

/**
 * Réduit une image en WebP ≤ THUMBNAIL_MAX_EDGE : orientation EXIF appliquée,
 * transparence conservée, jamais d'agrandissement, première image d'un GIF.
 */
export async function encodeThumbnail(input: Buffer): Promise<EncodedThumbnail> {
  const { default: sharp } = await import('sharp');
  const encode = async (quality: number) => {
    const { data, info } = await sharp(input, { limitInputPixels: IMAGE_MAX_INPUT_PIXELS, failOn: 'error', animated: false })
      .rotate()
      .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality, alphaQuality: 80, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    return { body: data, width: info.width, height: info.height, format: THUMBNAIL_FORMAT };
  };
  const first = await encode(THUMBNAIL_QUALITY);
  if (first.body.length <= THUMBNAIL_MAX_BYTES) return first;
  return encode(THUMBNAIL_FALLBACK_QUALITY);
}

// ── Dépendances (injectables pour les tests) ──────────────────────────────

export interface ThumbnailDeps {
  /** Lit l'original, au plus `maxBytes` octets (lève `SourceTooLargeError` au-delà). */
  readObject(bucket: string, key: string, maxBytes: number): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  renderPdf(pdf: Buffer, width: number): Promise<Buffer>;
}

export class SourceTooLargeError extends Error {
  constructor() { super('SOURCE_TOO_LARGE'); this.name = 'SourceTooLargeError'; }
}

const defaultDeps: ThumbnailDeps = {
  async readObject(bucket, key, maxBytes) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await getS3Client('worker').send(new GetObjectCommand({ Bucket: bucket || getS3Bucket(), Key: key }));
    if (typeof res.ContentLength === 'number' && res.ContentLength > maxBytes) {
      (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new SourceTooLargeError();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of res.Body as AsyncIterable<Uint8Array>) {
      total += c.length;
      if (total > maxBytes) {
        (res.Body as { destroy?: () => void }).destroy?.();
        throw new SourceTooLargeError();
      }
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  },
  async putObject(key, body, contentType) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await getS3Client('worker').send(new PutObjectCommand({
      Bucket: getS3Bucket(),
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
      CacheControl: 'private, max-age=31536000, immutable',
      Metadata: { 'x-verebona-type': 'thumbnail' },
    }));
  },
  async deleteObject(key) {
    const { deleteStorageObjects } = await import('@/services/storage/blob-purge.service');
    await deleteStorageObjects([key]);
  },
  renderPdf: (pdf, width) => renderPdfFirstPage(pdf, { width }),
};

// ── Réservation / écriture en base ────────────────────────────────────────

export interface ThumbnailSource {
  id: number;
  accountId: number;
  s3Key: string;
  s3Bucket: string | null;
  size: number | null;
  kind: ThumbnailSourceKind;
}

/**
 * Réserve la génération de (fichier, version). Renvoie le numéro de
 * tentative, ou null si rien à faire (déjà prête, en cours sous bail,
 * abandonnée, ou échec récent).
 */
export async function claimThumbnail(src: ThumbnailSource, now: Date = new Date()): Promise<{ id: number; attempts: number } | null> {
  const lease = new Date(now.getTime() + THUMBNAIL_LEASE_MS);
  const retryBefore = new Date(now.getTime() - THUMBNAIL_RETRY_DELAY_MS);
  const t = assetFileThumbnails;
  const rows = await db
    .insert(t)
    .values({
      fileId: src.id,
      accountId: src.accountId,
      variant: THUMBNAIL_VARIANT,
      status: 'PROCESSING',
      sourceKey: src.s3Key,
      sourceSize: src.size,
      attempts: 1,
      leaseUntil: lease,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [t.fileId, t.variant],
      set: {
        status: 'PROCESSING',
        attempts: sql`CASE WHEN ${t.sourceKey} IS DISTINCT FROM excluded.source_key THEN 1 ELSE ${t.attempts} + 1 END`,
        // Nouvelle version : l'ancien dérivé est retiré (purge par déclencheur).
        s3Key: sql`CASE WHEN ${t.sourceKey} IS DISTINCT FROM excluded.source_key THEN NULL ELSE ${t.s3Key} END`,
        sourceKey: sql`excluded.source_key`,
        sourceSize: sql`excluded.source_size`,
        accountId: sql`excluded.account_id`,
        leaseUntil: lease,
        errorCode: null,
        updatedAt: now,
      },
      setWhere: sql`
        ${t.sourceKey} IS DISTINCT FROM excluded.source_key
        OR ${t.status} = 'PENDING'
        OR (${t.status} = 'READY' AND ${t.s3Key} IS NULL)
        OR (${t.status} = 'PROCESSING' AND (${t.leaseUntil} IS NULL OR ${t.leaseUntil} < ${now.toISOString()}::timestamptz))
        OR (${t.status} = 'FAILED' AND ${t.attempts} < ${THUMBNAIL_MAX_ATTEMPTS} AND ${t.updatedAt} <= ${retryBefore.toISOString()}::timestamptz)
      `,
    })
    .returning({ id: t.id, attempts: t.attempts });
  return rows[0] ?? null;
}

async function finish(
  claim: { id: number; attempts: number },
  sourceKey: string,
  values: Partial<typeof assetFileThumbnails.$inferInsert>,
): Promise<boolean> {
  const t = assetFileThumbnails;
  const rows = await db
    .update(t)
    .set({ ...values, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(t.id, claim.id), eq(t.sourceKey, sourceKey), eq(t.status, 'PROCESSING'), eq(t.attempts, claim.attempts)))
    .returning({ id: t.id });
  return rows.length > 0;
}

// ── Génération ────────────────────────────────────────────────────────────

export type ThumbnailOutcome =
  | 'READY' | 'FAILED' | 'UNSUPPORTED'
  | 'SKIPPED_NOT_ELIGIBLE' | 'SKIPPED_NOT_CLAIMED' | 'SKIPPED_SUPERSEDED' | 'SKIPPED_DISABLED';

async function loadSource(fileId: number): Promise<ThumbnailSource | null> {
  const [f] = await db
    .select({
      id: assetFiles.id,
      accountId: assetFiles.accountId,
      s3Key: assetFiles.s3Key,
      s3Bucket: assetFiles.s3Bucket,
      size: assetFiles.size,
      mimeType: assetFiles.mimeType,
      fileExtension: assetFiles.fileExtension,
      originalFilename: assetFiles.originalFilename,
      isWebLink: assetFiles.isWebLink,
      uploadStatus: assetFiles.uploadStatus,
      deletedAt: assetFiles.deletedAt,
    })
    .from(assetFiles)
    .where(eq(assetFiles.id, fileId))
    .limit(1);
  if (!f || !f.s3Key) return null;
  if (f.uploadStatus !== 'COMPLETED' && f.uploadStatus !== null) return null;
  // Document supprimé : pas de génération (une source regroupée reste
  // consultable, mais son aperçu n'est pas affiché dans les listes).
  if (f.deletedAt) return null;
  const kind = thumbnailSourceKind(f);
  if (!kind) return null;
  return { id: f.id, accountId: f.accountId, s3Key: f.s3Key, s3Bucket: f.s3Bucket, size: f.size, kind };
}

/**
 * Génère la miniature d'un fichier si nécessaire. Ne lève pas pour une
 * erreur de contenu (statut FAILED/UNSUPPORTED enregistré) ; lève seulement
 * si la base est indisponible.
 */
export async function generateThumbnail(fileId: number, deps: ThumbnailDeps = defaultDeps): Promise<ThumbnailOutcome> {
  if (!thumbnailsEnabled()) return 'SKIPPED_DISABLED';
  const src = await loadSource(fileId);
  if (!src) return 'SKIPPED_NOT_ELIGIBLE';
  const maxBytes = src.kind === 'pdf' ? PDF_MAX_SOURCE_BYTES : IMAGE_MAX_SOURCE_BYTES;
  if (src.size != null && src.size > maxBytes) {
    const claim = await claimThumbnail(src);
    if (!claim) return 'SKIPPED_NOT_CLAIMED';
    await finish(claim, src.s3Key, { status: 'UNSUPPORTED', errorCode: 'SOURCE_TOO_LARGE' });
    return 'UNSUPPORTED';
  }

  const claim = await claimThumbnail(src);
  if (!claim) return 'SKIPPED_NOT_CLAIMED';

  const started = Date.now();
  try {
    const original = await deps.readObject(src.s3Bucket ?? '', src.s3Key, maxBytes);
    const raster = src.kind === 'pdf' ? await deps.renderPdf(original, THUMBNAIL_MAX_EDGE) : original;
    const encoded = await encodeThumbnail(raster);
    const key = documentThumbnailKey(src.accountId, src.id, src.s3Key);
    await deps.putObject(key, encoded.body, encoded.format);
    const ok = await finish(claim, src.s3Key, {
      status: 'READY',
      s3Key: key,
      format: encoded.format,
      width: encoded.width,
      height: encoded.height,
      bytes: encoded.body.length,
      errorCode: null,
      generatedAt: new Date(),
    });
    if (!ok) {
      // Version remplacée ou bail repris entre-temps : l'objet écrit n'est
      // référencé par personne si la ligne porte une autre clé.
      const [row] = await db.select({ s3Key: assetFileThumbnails.s3Key }).from(assetFileThumbnails).where(eq(assetFileThumbnails.id, claim.id)).limit(1);
      if (row?.s3Key !== key) await deps.deleteObject(key).catch(() => undefined);
      return 'SKIPPED_SUPERSEDED';
    }
    console.info(`[thumbnails] fichier ${src.id} (${src.kind}) : ${encoded.width}×${encoded.height}, ${encoded.body.length} o, ${Date.now() - started} ms`);
    return 'READY';
  } catch (error) {
    const { status, code } = classifyGenerationError(error);
    await finish(claim, src.s3Key, { status, errorCode: code }).catch(() => undefined);
    console.warn(`[thumbnails] fichier ${src.id} (${src.kind}) : ${status} ${code} après ${Date.now() - started} ms`);
    return status;
  }
}

/** Échec définitif (UNSUPPORTED) ou transitoire (FAILED, retenté borné). */
export function classifyGenerationError(error: unknown): { status: 'FAILED' | 'UNSUPPORTED'; code: string } {
  if (error instanceof SourceTooLargeError) return { status: 'UNSUPPORTED', code: 'SOURCE_TOO_LARGE' };
  if (error instanceof PdfRenderError) return { status: error.permanent ? 'UNSUPPORTED' : 'FAILED', code: error.code };
  const msg = String((error as Error)?.message ?? '');
  // Erreurs de décodage sharp/libvips : format illisible, définitif.
  if (/unsupported image format|Input buffer contains unsupported|corrupt|bad seek|VipsJpeg|pngload|webpload|heif|Input image exceeds pixel limit/i.test(msg)) {
    return { status: 'UNSUPPORTED', code: 'IMAGE_UNREADABLE' };
  }
  const s3 = classifyS3Error(error);
  if (s3.kind === 'NOT_FOUND') return { status: 'UNSUPPORTED', code: 'SOURCE_MISSING' };
  if (s3.kind !== 'OTHER') return { status: 'FAILED', code: `S3_${s3.kind}` };
  return { status: 'FAILED', code: 'GENERATION_ERROR' };
}

// ── File en mémoire, bornée ───────────────────────────────────────────────

const queue = new Set<number>();
let running = 0;

/** Demande la génération (fire-and-forget). Ne lève jamais. */
export function enqueueThumbnail(fileId: number): boolean {
  if (!thumbnailsEnabled() || !Number.isInteger(fileId)) return false;
  if (queue.has(fileId)) return true;
  if (queue.size >= MAX_QUEUE) return false;
  queue.add(fileId);
  setImmediate(drain);
  return true;
}

export function enqueueThumbnails(fileIds: number[]): void {
  for (const id of fileIds) enqueueThumbnail(id);
}

function drain(): void {
  while (running < concurrency() && queue.size > 0) {
    const fileId = queue.values().next().value as number;
    queue.delete(fileId);
    running++;
    generateThumbnail(fileId)
      .catch((e) => console.error(`[thumbnails] fichier ${fileId} : ${(e as Error)?.message}`))
      .finally(() => {
        running--;
        if (queue.size > 0) setImmediate(drain);
      });
  }
}

/** État de la file (supervision, tests). */
export function thumbnailQueueStats(): { queued: number; running: number } {
  return { queued: queue.size, running };
}

// ── Lecture pour l'affichage ──────────────────────────────────────────────

export async function getThumbnailRow(fileId: number) {
  const [row] = await db
    .select({
      status: assetFileThumbnails.status,
      sourceKey: assetFileThumbnails.sourceKey,
      s3Key: assetFileThumbnails.s3Key,
      attempts: assetFileThumbnails.attempts,
      leaseUntil: assetFileThumbnails.leaseUntil,
      updatedAt: assetFileThumbnails.updatedAt,
    })
    .from(assetFileThumbnails)
    .where(and(eq(assetFileThumbnails.fileId, fileId), eq(assetFileThumbnails.variant, THUMBNAIL_VARIANT)))
    .limit(1);
  return row ?? null;
}

// ── Rattrapage borné des documents existants ──────────────────────────────

/**
 * Met en file au plus `limit` documents éligibles sans miniature à jour
 * (plus récents d'abord). Les échecs abandonnés ne sont pas repris.
 */
export async function runThumbnailBackfill(options: { limit?: number } = {}): Promise<{ enqueued: number }> {
  if (!thumbnailsEnabled()) return { enqueued: 0 };
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_QUEUE);
  const t = assetFileThumbnails;
  const rows = await db
    .select({
      id: assetFiles.id,
      mimeType: assetFiles.mimeType,
      fileExtension: assetFiles.fileExtension,
      originalFilename: assetFiles.originalFilename,
      s3Key: assetFiles.s3Key,
      isWebLink: assetFiles.isWebLink,
    })
    .from(assetFiles)
    .leftJoin(t, and(eq(t.fileId, assetFiles.id), eq(t.variant, THUMBNAIL_VARIANT)))
    .where(and(
      isNull(assetFiles.deletedAt),
      or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
      eq(assetFiles.isWebLink, false),
      sql`${assetFiles.s3Key} IS NOT NULL`,
      sql`(${assetFiles.mimeType} ILIKE 'image/%' OR ${assetFiles.mimeType} ILIKE '%pdf%' OR ${assetFiles.fileExtension} ILIKE 'pdf')`,
      or(isNull(t.id), sql`${t.sourceKey} IS DISTINCT FROM ${assetFiles.s3Key}`, eq(t.status, 'PENDING')),
    ))
    .orderBy(desc(assetFiles.id))
    .limit(limit);
  let enqueued = 0;
  for (const r of rows) {
    if (thumbnailSourceKind(r) && enqueueThumbnail(r.id)) enqueued++;
  }
  return { enqueued };
}
