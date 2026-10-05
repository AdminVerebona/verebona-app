import { Sha256, enHex } from '@/lib/sha256-incremental';

/**
 * File validation utilities for security
 * - Magic bytes verification (not just client-provided MIME)
 * - Strict filename sanitization
 * - Extension validation
 */

// Magic bytes signatures for allowed file types
const MAGIC_BYTES: Record<string, { bytes: number[][]; mimeType: string; extensions: string[] }> = {
  // Images
  'image/jpeg': {
    bytes: [[0xFF, 0xD8, 0xFF]],
    mimeType: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
  },
  'image/png': {
    bytes: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
    mimeType: 'image/png',
    extensions: ['png'],
  },
  'image/gif': {
    bytes: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    mimeType: 'image/gif',
    extensions: ['gif'],
  },
  'image/webp': {
    bytes: [[0x52, 0x49, 0x46, 0x46]], // RIFF header, WEBP at offset 8
    mimeType: 'image/webp',
    extensions: ['webp'],
  },
  
  // Documents
  'application/pdf': {
    bytes: [[0x25, 0x50, 0x44, 0x46]], // %PDF
    mimeType: 'application/pdf',
    extensions: ['pdf'],
  },
  
  // Microsoft Office (ZIP-based formats)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    bytes: [[0x50, 0x4B, 0x03, 0x04]], // ZIP signature
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    bytes: [[0x50, 0x4B, 0x03, 0x04]], // ZIP signature
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
  },
  
  // Legacy Office
  'application/msword': {
    bytes: [[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]], // OLE compound file
    mimeType: 'application/msword',
    extensions: ['doc'],
  },
  'application/vnd.ms-excel': {
    bytes: [[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]], // OLE compound file
    mimeType: 'application/vnd.ms-excel',
    extensions: ['xls'],
  },
  
  // Text files (no magic bytes, validated by extension only)
  'text/plain': {
    bytes: [],
    mimeType: 'text/plain',
    extensions: ['txt'],
  },
  'text/csv': {
    bytes: [],
    mimeType: 'text/csv',
    extensions: ['csv'],
  },

  // Video files
  'video/mp4': {
    bytes: [
      [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], // ftyp box at offset 0 (common)
      [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70], // ftyp box variant
      [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70], // ftyp box variant
    ],
    mimeType: 'video/mp4',
    extensions: ['mp4', 'm4v'],
  },
  'video/quicktime': {
    bytes: [
      [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70], // ftyp qt
      [0x00, 0x00, 0x00, 0x08, 0x77, 0x69, 0x64, 0x65], // wide
    ],
    mimeType: 'video/quicktime',
    extensions: ['mov'],
  },
  'video/x-msvideo': {
    bytes: [[0x52, 0x49, 0x46, 0x46]], // RIFF
    mimeType: 'video/x-msvideo',
    extensions: ['avi'],
  },
  'video/webm': {
    bytes: [[0x1A, 0x45, 0xDF, 0xA3]], // EBML
    mimeType: 'video/webm',
    extensions: ['webm'],
  },
  'video/x-matroska': {
    bytes: [[0x1A, 0x45, 0xDF, 0xA3]], // EBML
    mimeType: 'video/x-matroska',
    extensions: ['mkv'],
  },
};

// Dangerous extensions to always block (even if MIME seems safe)
const BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'sh', 'bash', 'ps1', 'vbs', 'js', 'mjs', 'cjs',
  'jar', 'app', 'deb', 'rpm', 'dmg', 'pkg', 'run',
  'html', 'htm', 'svg', 'xml', 'xsl', 'xslt',
  'php', 'asp', 'aspx', 'jsp', 'py', 'rb', 'pl',
  'dll', 'so', 'dylib', 'sys',
];

// Allowed MIME types (client-provided, still validated server-side)
export const ALLOWED_MIME_TYPES = Object.keys(MAGIC_BYTES);

/**
 * Sanitize filename: ASCII-safe, max 255 chars, no dangerous sequences
 * - Removes accents and special characters
 * - Blocks: ../, null bytes, control characters
 * - Keeps: alphanumeric, dots, dashes, underscores
 */
export function sanitizeFilename(filename: string): string | null {
  if (!filename || typeof filename !== 'string') {
    return null;
  }

  // Remove path traversal attempts
  if (filename.includes('../') || filename.includes('..\\')) {
    return null;
  }

  // Check for null bytes
  if (filename.includes('\0')) {
    return null;
  }

  // Split extension
  const parts = filename.split('.');
  if (parts.length < 2) {
    return null; // Must have an extension
  }

  const extension = parts.pop()!.toLowerCase();
  const nameWithoutExt = parts.join('.');

  // Block dangerous extensions
  if (BLOCKED_EXTENSIONS.includes(extension)) {
    return null;
  }

  // Sanitize name part
  const sanitizedName = nameWithoutExt
    .normalize('NFD') // Decompose accents
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace non-ASCII/special chars
    .replace(/_{2,}/g, '_') // Collapse multiple underscores
    .replace(/^[._-]+|[._-]+$/g, '') // Trim leading/trailing dots/dashes/underscores
    .substring(0, 200); // Limit name length

  if (!sanitizedName) {
    return null;
  }

  const sanitized = `${sanitizedName}.${extension}`;

  // Final length check (filesystem limit)
  if (sanitized.length > 255) {
    return null;
  }

  return sanitized;
}

/**
 * Verify file type via magic bytes
 * Returns { valid: boolean, detectedMime?: string, error?: string }
 */
export async function verifyFileMagicBytes(
  buffer: Buffer,
  expectedMime: string
): Promise<{ valid: boolean; detectedMime?: string; error?: string }> {
  // Text files have no magic bytes
  if (expectedMime === 'text/plain' || expectedMime === 'text/csv') {
    return { valid: true, detectedMime: expectedMime };
  }

  // MP4/MOV/QuickTime: detect by searching for 'ftyp' box anywhere in first 32 bytes
  if (expectedMime === 'video/mp4' || expectedMime === 'video/quicktime') {
    const header = buffer.slice(0, 32).toString('ascii', 4, 8);
    if (header === 'ftyp' || header === 'wide' || header === 'mdat' || header === 'moov') {
      return { valid: true, detectedMime: expectedMime };
    }
    // Also check at offset 0 for some variants
    const altHeader = buffer.slice(0, 12).toString('ascii', 4, 8);
    if (altHeader === 'ftyp') {
      return { valid: true, detectedMime: expectedMime };
    }
    return { valid: false, error: 'File content does not match declared MIME type (magic bytes mismatch)' };
  }

  const magicInfo = MAGIC_BYTES[expectedMime];
  if (!magicInfo) {
    return { valid: false, error: 'MIME type not in allowed list' };
  }

  // Check if any magic byte signature matches
  for (const signature of magicInfo.bytes) {
    if (signature.length === 0) continue; // Skip empty signatures (text files)

    const matches = signature.every((byte, index) => {
      if (index >= buffer.length) return false;
      return buffer[index] === byte;
    });

    if (matches) {
      // Special case for WEBP: check for "WEBP" at offset 8
      if (expectedMime === 'image/webp') {
        const webpMarker = buffer.slice(8, 12).toString('ascii');
        if (webpMarker === 'WEBP') {
          return { valid: true, detectedMime: expectedMime };
        }
      } else {
        return { valid: true, detectedMime: expectedMime };
      }
    }
  }

  return {
    valid: false,
    error: 'File content does not match declared MIME type (magic bytes mismatch)',
  };
}

// Extension-to-MIME fallback map for browsers that report wrong MIME types
const EXTENSION_MIME_MAP: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
};

/**
 * Normalize MIME type for a file.
 * Some browsers/OS report .docx as application/zip or application/octet-stream.
 * This function corrects the MIME type based on the file extension when needed.
 */
export function normalizeMimeType(file: File): string {
  const unreliableMimes = ['', 'application/octet-stream', 'application/zip'];
  if (!unreliableMimes.includes(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME_MAP[ext] ?? file.type ?? 'application/octet-stream';
}

/**
 * Validate file extension matches MIME type
 */
export function validateExtension(filename: string, mimeType: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (!extension) return false;

  const magicInfo = MAGIC_BYTES[mimeType];
  if (!magicInfo) return false;

  return magicInfo.extensions.includes(extension);
}

/** Empreinte SHA-256 hexadécimale (64 caractères minuscules). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Vraie empreinte SHA-256 ? Écarte les valeurs de repli (« placeholder-hash »
 * d'anciens dépôts) et toute chaîne arbitraire : une valeur commune à
 * plusieurs fichiers ferait passer des documents distincts pour des doublons.
 */
export function estEmpreinteSha256(valeur: unknown): valeur is string {
  return typeof valeur === 'string' && SHA256_HEX.test(valeur);
}

/** Échec du calcul d'empreinte : jamais remplacé par une valeur de repli. */
export class EmpreinteIndisponibleError extends Error {
  constructor(cause?: unknown) {
    super("Impossible de calculer l'empreinte du fichier. Réessayez ; si le problème persiste, resélectionnez le fichier.");
    this.name = 'EmpreinteIndisponibleError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Taille des tranches lues pour l'empreinte : la seule mémoire retenue. */
export const TRANCHE_EMPREINTE = 4 * 1024 * 1024;

/**
 * Empreinte SHA-256 d'un fichier, mémoire bornée — APP-PERF-24.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ANCIENNE VERSION N'ÉTAIT PAS INCRÉMENTALE
 *
 * Elle lisait des tranches de 8 Mo, les CONSERVAIT toutes, allouait un
 * tableau de la taille du fichier et les y recopiait avant un `digest`
 * unique : deux copies complètes simultanées (≈ 200 Mo pour une vidéo de
 * 100 Mo), malgré son commentaire.
 *
 * Désormais :
 *   · fichier ≤ une tranche : `crypto.subtle.digest` natif sur l'unique
 *     tampon lu (une seule copie, de taille bornée par la tranche) ;
 *   · au-delà : SHA-256 incrémental (`sha256-incremental.ts`), une tranche
 *     lue à la fois puis relâchée — mémoire bornée à `TRANCHE_EMPREINTE`.
 *
 * L'annulation (`signal`) est contrôlée entre deux tranches ; la progression
 * (`onProgress`, 0 → 1) permet d'afficher une préparation mesurable.
 * Une erreur de lecture lève `EmpreinteIndisponibleError` : AUCUNE valeur de
 * repli n'est renvoyée.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function computeFileSha256(
  file: Blob,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void; trancheOctets?: number } = {},
): Promise<string> {
  const tranche = Math.max(64, options.trancheOctets ?? TRANCHE_EMPREINTE);
  const verifierAnnulation = () => {
    if (options.signal?.aborted) {
      const e = new Error('Upload annulé');
      e.name = 'AbortError';
      throw e;
    }
  };
  verifierAnnulation();
  try {
    const subtle = globalThis.crypto?.subtle;
    if (file.size <= tranche && subtle) {
      const buf = await file.arrayBuffer();
      verifierAnnulation();
      const digest = await subtle.digest('SHA-256', buf);
      options.onProgress?.(1);
      return enHex(new Uint8Array(digest));
    }
    const h = new Sha256();
    for (let offset = 0; offset < file.size; offset += tranche) {
      const buf = await file.slice(offset, Math.min(offset + tranche, file.size)).arrayBuffer();
      verifierAnnulation();
      h.update(new Uint8Array(buf));
      options.onProgress?.(Math.min(1, (offset + buf.byteLength) / file.size));
    }
    if (file.size === 0) options.onProgress?.(1);
    return h.digestHex();
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new EmpreinteIndisponibleError(e);
  }
}
