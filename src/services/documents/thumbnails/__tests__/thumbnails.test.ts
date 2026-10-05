/**
 * APP-PERF-06 / APP-PERF-27 — miniatures de documents : éligibilité, version,
 * décision d'affichage, encodage image (sharp) et rendu PDF isolé.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  decideThumbnail,
  documentThumbnailKey,
  isThumbnailCandidate,
  thumbnailSourceKind,
  THUMBNAIL_MAX_ATTEMPTS,
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_RETRY_DELAY_MS,
} from '../thumbnail-spec';
import { classifyGenerationError, encodeThumbnail, SourceTooLargeError } from '../thumbnail.service';
import { PdfRenderError, renderPdfFirstPage } from '../pdf-render';
import { decideFileAccess } from '@/services/documents/file-access';

describe('éligibilité', () => {
  it('images raster et PDF ; ni SVG, ni lien web, ni fichier sans objet', () => {
    expect(thumbnailSourceKind({ mimeType: 'image/jpeg', s3Key: 'k' })).toBe('image');
    expect(thumbnailSourceKind({ mimeType: 'application/pdf', s3Key: 'k' })).toBe('pdf');
    expect(thumbnailSourceKind({ mimeType: 'application/octet-stream', originalFilename: 'Facture.PDF', s3Key: 'k' })).toBe('pdf');
    expect(thumbnailSourceKind({ mimeType: null, fileExtension: 'png', s3Key: 'k' })).toBe('image');
    expect(isThumbnailCandidate({ mimeType: 'image/svg+xml', s3Key: 'k' })).toBe(false);
    expect(isThumbnailCandidate({ mimeType: 'image/jpeg', s3Key: 'k', isWebLink: true })).toBe(false);
    expect(isThumbnailCandidate({ mimeType: 'image/jpeg', s3Key: null })).toBe(false);
    expect(isThumbnailCandidate({ mimeType: 'application/vnd.ms-excel', s3Key: 'k' })).toBe(false);
  });

  it('T-02 / T-03 : clé du dérivé propre au compte, au document ET à la version source', () => {
    const k1 = documentThumbnailKey(1, 10, 'verebona/u_1/a.pdf');
    expect(k1).toMatch(/^derivatives\/thumbnails\/a_1\/f_10\/list-[0-9a-f]{16}\.webp$/);
    expect(documentThumbnailKey(1, 10, 'verebona/u_1/a.pdf')).toBe(k1);
    expect(documentThumbnailKey(1, 10, 'verebona/u_1/a-v2.pdf')).not.toBe(k1);
    expect(documentThumbnailKey(1, 11, 'verebona/u_1/a.pdf')).not.toBe(k1);
    expect(documentThumbnailKey(2, 10, 'verebona/u_1/a.pdf')).not.toBe(k1);
  });
});

describe('decideThumbnail', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const row = (over: Partial<Parameters<typeof decideThumbnail>[0] & object> = {}) => ({
    status: 'READY', sourceKey: 'src-v1', s3Key: 'derivatives/x.webp', attempts: 1, leaseUntil: null, updatedAt: now, ...over,
  });

  it('CA-01 : dérivé prêt de la version courante → servi (partagé par tous les appareils)', () => {
    expect(decideThumbnail(row(), 'src-v1', now)).toEqual({ action: 'serve', s3Key: 'derivatives/x.webp' });
  });
  it('T-02 : fichier remplacé → dérivé périmé jamais servi, régénération', () => {
    expect(decideThumbnail(row(), 'src-v2', now)).toEqual({ action: 'generate' });
  });
  it('absent → génération ; en cours sous bail → attente ; bail expiré → reprise', () => {
    expect(decideThumbnail(null, 'src-v1', now)).toEqual({ action: 'generate' });
    expect(decideThumbnail(row({ status: 'PROCESSING', leaseUntil: new Date(now.getTime() + 1000) }), 'src-v1', now)).toEqual({ action: 'wait' });
    expect(decideThumbnail(row({ status: 'PROCESSING', leaseUntil: new Date(now.getTime() - 1000) }), 'src-v1', now)).toEqual({ action: 'generate' });
  });
  it('T-03 : illisible → placeholder définitif ; échec → délai puis tentatives bornées, sans boucle', () => {
    expect(decideThumbnail(row({ status: 'UNSUPPORTED' }), 'src-v1', now)).toEqual({ action: 'placeholder', reason: 'UNSUPPORTED' });
    expect(decideThumbnail(row({ status: 'FAILED', attempts: 1, updatedAt: now }), 'src-v1', now)).toEqual({ action: 'placeholder', reason: 'FAILED' });
    const ancien = new Date(now.getTime() - THUMBNAIL_RETRY_DELAY_MS - 1);
    expect(decideThumbnail(row({ status: 'FAILED', attempts: 1, updatedAt: ancien }), 'src-v1', now)).toEqual({ action: 'generate' });
    expect(decideThumbnail(row({ status: 'FAILED', attempts: THUMBNAIL_MAX_ATTEMPTS, updatedAt: ancien }), 'src-v1', now)).toEqual({ action: 'placeholder', reason: 'FAILED' });
  });
});

describe('encodeThumbnail (sharp)', () => {
  it('CA-02 : réduction ≤ 480 px en WebP, transparence conservée, original intact', async () => {
    const original = await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    const copie = Buffer.from(original);
    const t = await encodeThumbnail(original);
    expect(t.format).toBe('image/webp');
    expect(Math.max(t.width, t.height)).toBe(THUMBNAIL_MAX_EDGE);
    expect(t.width).toBe(480);
    expect(t.height).toBe(320);
    const meta = await sharp(t.body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.hasAlpha).toBe(true);
    expect(t.body.length).toBeLessThan(original.length);
    expect(original.equals(copie)).toBe(true);
  });

  it('CA-02 : orientation EXIF appliquée ; jamais d’agrandissement', async () => {
    // 200 × 100 stockée avec orientation 6 (rotation 90°) → affichée 100 × 200.
    const jpeg = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#3366ff' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const t = await encodeThumbnail(jpeg);
    expect({ w: t.width, h: t.height }).toEqual({ w: 100, h: 200 });
  });

  it('T-03 : format illisible → UNSUPPORTED (pas de nouvel essai)', async () => {
    let err: unknown;
    try { await encodeThumbnail(Buffer.from('ceci n’est pas une image')); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(classifyGenerationError(err)).toEqual({ status: 'UNSUPPORTED', code: 'IMAGE_UNREADABLE' });
    expect(classifyGenerationError(new SourceTooLargeError()).status).toBe('UNSUPPORTED');
    expect(classifyGenerationError({ name: 'TimeoutError' })).toEqual({ status: 'FAILED', code: 'S3_TIMEOUT' });
    expect(classifyGenerationError({ name: 'NoSuchKey' })).toEqual({ status: 'UNSUPPORTED', code: 'SOURCE_MISSING' });
  });
});

describe('rendu PDF serveur (processus enfant borné)', () => {
  const pdfSimple = async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.drawText('Facture', { x: 50, y: 700, size: 40, font: await doc.embedFont(StandardFonts.Helvetica) });
    return Buffer.from(await doc.save());
  };

  it('1re page rendue en PNG, puis miniature WebP', async () => {
    const png = await renderPdfFirstPage(await pdfSimple(), { width: THUMBNAIL_MAX_EDGE });
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(680);
    const t = await encodeThumbnail(png);
    expect(t.width).toBeLessThanOrEqual(480);
    expect(t.height).toBe(480);
  });

  it('T-02 : PDF corrompu → PDF_INVALID (définitif)', async () => {
    await expect(renderPdfFirstPage(Buffer.from('%PDF-1.7 pas vraiment un pdf'), { width: 200 })).rejects.toMatchObject({ code: 'PDF_INVALID' });
    const e = new PdfRenderError('PDF_INVALID');
    expect(classifyGenerationError(e)).toEqual({ status: 'UNSUPPORTED', code: 'PDF_INVALID' });
  });

  it('T-02 : PDF protégé par mot de passe → PDF_PASSWORD (définitif)', async () => {
    const protege = readFileSync(join(__dirname, 'fixtures', 'protege-mot-de-passe.pdf'));
    await expect(renderPdfFirstPage(protege, { width: 200 })).rejects.toMatchObject({ code: 'PDF_PASSWORD' });
  });

  it('T-02 : délai dépassé → processus tué, PDF_TIMEOUT (transitoire, tentatives bornées)', async () => {
    const err = await renderPdfFirstPage(await pdfSimple(), { width: 200, timeoutMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect(err.code).toBe('PDF_TIMEOUT');
    expect(classifyGenerationError(err).status).toBe('FAILED');
  });
});

describe('garde d’accès (décision pure)', () => {
  const f = { id: 1, accountId: 7, s3Bucket: 'b', s3Key: 'k', mimeType: 'image/png', size: 1, originalFilename: 'a.png', isWebLink: false, uploadStatus: 'COMPLETED' };
  it('CA-03 : autre compte → 404 (existence non confirmée) ; absent → 404 ; non prêt → 409', () => {
    expect(decideFileAccess(f, 7)).toEqual({ ok: true });
    expect(decideFileAccess(f, 8)).toEqual({ ok: false, status: 404, code: 'FILE_NOT_FOUND' });
    expect(decideFileAccess(undefined, 7)).toEqual({ ok: false, status: 404, code: 'FILE_NOT_FOUND' });
    expect(decideFileAccess({ ...f, uploadStatus: 'PENDING' }, 7)).toEqual({ ok: false, status: 409, code: 'FILE_NOT_READY' });
    expect(decideFileAccess({ ...f, uploadStatus: null }, 7)).toEqual({ ok: true });
  });
});

describe('câblage (source)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
  it('la liste vise la miniature, jamais l’original', () => {
    const vue = read('src/components/documents/v2/DocumentsByRubric.tsx');
    expect(vue).not.toMatch(/\/api\/files\/\$\{document\.id\}\/proxy/);
    expect(vue.match(/src=\{`\/api\/files\/\$\{document\.id\}\/thumbnail`\}/g)?.length).toBe(2);
  });
  it('confirmation : génération demandée, non bloquante, sans appel IA', () => {
    const c = read('src/app/api/files/confirm/route.ts');
    expect(c).toMatch(/void import\('@\/services\/documents\/thumbnails\/thumbnail\.service'\)/);
    expect(c).toContain('enqueueThumbnails(updatedFiles.map((f) => f.id))');
  });
  it('migration 0241 : table, contrainte unique (fichier, variante), purge par déclencheur', () => {
    const m = read('src/db/migrations/0241_asset_file_thumbnails.sql');
    expect(m).toContain('CREATE TABLE IF NOT EXISTS asset_file_thumbnails');
    expect(m).toContain('REFERENCES asset_files(id) ON DELETE CASCADE');
    expect(m).toContain('asset_file_thumbnails_file_variant_uidx');
    expect(m).toMatch(/INSERT INTO pending_blob_deletions/);
  });
});
