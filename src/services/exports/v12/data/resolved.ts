/**
 * Résultat de l'étape `resolve_files` (§15.3) : état de chaque pièce et photo
 * retenue après téléchargement et contrôle (SEL-GEN-006, ALT-004).
 *
 * Types seuls : les mappeurs en dépendent sans dépendre du stockage.
 */

export type FileStatus = 'ok' | 'missing' | 'corrupted' | 'protected' | 'unreadable' | 'too_large';

export interface ResolvedDocument {
  id: number;
  status: FileStatus;
  /** Nombre de pages (PDF) ; 1 pour une image. */
  pages: number | null;
  /** Fichier local (PDF source à apposer, image annexe, pièce ZIP). */
  localPath?: string;
  /** URL chargeable par Chromium pour une image intégrée en annexe. */
  imageUrl?: string;
  /** PDF : dimensions utiles (points) et rotation de chaque page, relevées à l'inspection. */
  boxes?: Array<{ width: number; height: number; rotation: number }>;
}

export interface ResolvedPhoto {
  id: number;
  status: FileStatus;
  /** URL chargeable par Chromium (image redimensionnée). */
  url?: string;
  /** Fichier original (ZIP). */
  localPath?: string;
}

export interface ResolvedFiles {
  documents: Map<number, ResolvedDocument>;
  photos: Map<number, ResolvedPhoto>;
}

/** Clé de photo dans les données (`PhotoItem.file`). */
export const photoFileKey = (photoId: number): string => `photo-${photoId}`;
