/**
 * Miniatures des documents — tailles, formats, éligibilité (APP-PERF-06/27).
 *
 * Module PUR (aucun import serveur) : utilisable par les routes, le service
 * de génération et l'interface.
 *
 * ── Surfaces d'affichage ─────────────────────────────────────────────────
 *   · ligne de liste « Mes documents » : 30 × 38 px CSS ;
 *   · vignette (grille, cadre 4:3) : ≈ 160 à 260 px CSS de large ;
 *   · le zoom et l'ouverture utilisent l'ORIGINAL (view/proxy/download).
 * Une variante unique `list` couvre les deux premières : 480 px sur le plus
 * grand côté (vignette nette jusqu'à ≈ 2× sur 240 px), WebP. Budget : la
 * cible est ≈ 15 à 50 Ko ; au-delà de `THUMBNAIL_MAX_BYTES` la qualité est
 * abaissée une fois (`THUMBNAIL_FALLBACK_QUALITY`). Budgets à affiner après
 * comparaison visuelle (MESURES du ticket).
 */

export const THUMBNAIL_VARIANT = 'list' as const;
export const THUMBNAIL_MAX_EDGE = 480;
export const THUMBNAIL_FORMAT = 'image/webp' as const;
export const THUMBNAIL_QUALITY = 72;
export const THUMBNAIL_FALLBACK_QUALITY = 50;
export const THUMBNAIL_MAX_BYTES = 120 * 1024;

/** Taille maximale des originaux traités (au-delà : UNSUPPORTED). */
export const IMAGE_MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const PDF_MAX_SOURCE_BYTES = 60 * 1024 * 1024;
/** Pixels d'entrée maximum pour une image (bombe de décompression). */
export const IMAGE_MAX_INPUT_PIXELS = 120_000_000;

/** Tentatives de génération par version source avant abandon (FAILED définitif). */
export const THUMBNAIL_MAX_ATTEMPTS = 3;
/** Bail d'une génération en cours : au-delà, elle est considérée interrompue. */
export const THUMBNAIL_LEASE_MS = 2 * 60 * 1000;
/** Délai minimal entre deux tentatives après un échec transitoire. */
export const THUMBNAIL_RETRY_DELAY_MS = 10 * 60 * 1000;

/**
 * Images traitées par sharp. SVG exclu (contenu actif, rendu non borné) ;
 * HEIC exclu (décodeur absent du sharp précompilé) : placeholder.
 */
const IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/tiff',
]);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff']);

export type ThumbnailSourceKind = 'image' | 'pdf';

export interface ThumbnailSourceFields {
  mimeType?: string | null;
  fileExtension?: string | null;
  originalFilename?: string | null;
  filename?: string | null;
  s3Key?: string | null;
  isWebLink?: boolean | null;
}

function extensionOf(f: ThumbnailSourceFields): string {
  const ext = f.fileExtension?.replace(/^\./, '').toLowerCase();
  if (ext) return ext;
  const name = f.originalFilename || f.filename || '';
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Type de source pour la génération, ou null si non éligible. */
export function thumbnailSourceKind(f: ThumbnailSourceFields): ThumbnailSourceKind | null {
  if (f.isWebLink || !f.s3Key || f.s3Key === 'temp') return null;
  const mime = (f.mimeType ?? '').toLowerCase().split(';')[0].trim();
  const ext = extensionOf(f);
  if (mime === 'application/pdf' || /pdf/.test(mime) || (ext === 'pdf' && (!mime || mime === 'application/octet-stream'))) return 'pdf';
  if (IMAGE_TYPES.has(mime)) return 'image';
  if ((!mime || mime === 'application/octet-stream') && IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

export function isThumbnailCandidate(f: ThumbnailSourceFields): boolean {
  return thumbnailSourceKind(f) !== null;
}

/** Courte empreinte (FNV-1a 32 bits ×2, hex) — pure, sans crypto. */
export function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Clé S3 du dérivé. Elle dépend de la VERSION source (clé de l'original) :
 * un fichier remplacé produit une autre clé — jamais de miniature obsolète
 * servie sous la même URL, ni réutilisée pour un autre document.
 */
export function documentThumbnailKey(accountId: number, fileId: number, sourceKey: string, variant: string = THUMBNAIL_VARIANT): string {
  return `derivatives/thumbnails/a_${accountId}/f_${fileId}/${variant}-${shortHash(sourceKey)}.webp`;
}

export type ThumbnailRowStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'UNSUPPORTED';

export interface ThumbnailRowLike {
  status: string;
  sourceKey: string;
  s3Key: string | null;
  attempts: number;
  leaseUntil: Date | null;
  updatedAt: Date;
}

export type ThumbnailDecision =
  | { action: 'serve'; s3Key: string }
  | { action: 'generate' }
  | { action: 'wait' }
  | { action: 'placeholder'; reason: 'FAILED' | 'UNSUPPORTED' };

/**
 * Que faire pour afficher la miniature d'un fichier dont l'original courant
 * a la clé `currentSourceKey` ? Pure — testée unitairement.
 */
export function decideThumbnail(row: ThumbnailRowLike | null | undefined, currentSourceKey: string, now: Date = new Date()): ThumbnailDecision {
  if (!row) return { action: 'generate' };
  // Version différente : dérivé périmé, jamais servi.
  if (row.sourceKey !== currentSourceKey) return { action: 'generate' };
  switch (row.status) {
    case 'READY':
      return row.s3Key ? { action: 'serve', s3Key: row.s3Key } : { action: 'generate' };
    case 'PROCESSING':
      return row.leaseUntil && row.leaseUntil.getTime() > now.getTime() ? { action: 'wait' } : { action: 'generate' };
    case 'PENDING':
      return { action: 'generate' };
    case 'UNSUPPORTED':
      return { action: 'placeholder', reason: 'UNSUPPORTED' };
    case 'FAILED':
      if (row.attempts >= THUMBNAIL_MAX_ATTEMPTS) return { action: 'placeholder', reason: 'FAILED' };
      return now.getTime() - row.updatedAt.getTime() >= THUMBNAIL_RETRY_DELAY_MS ? { action: 'generate' } : { action: 'placeholder', reason: 'FAILED' };
    default:
      return { action: 'generate' };
  }
}
