/**
 * Sélection et plan des pièces (CDC §6.1, §14) — commun aux six templates.
 *
 * Portage fidèle de `maquettes/_system/selection.mjs`.
 *
 * Contrat : chaque dossier porte `documents[]` et `photos[]` avec l'état de
 * sélection de l'écran de préparation (`selected`, `mode`).
 *
 *  SEL-GEN-001  un élément non sélectionné n'apparaît nulle part (PDF, ZIP, listes) ;
 *  SEL-GEN-002  un document sélectionné a un mode PDF ou ZIP ;
 *  SEL-GEN-003/4/5  formats intégrables PDF, JPG, JPEG, PNG, WebP ; un document
 *               demandé en PDF mais non intégrable bascule en ZIP ;
 *  SEL-GEN-006 / ZIP-008  un fichier corrompu (`corrupted: true`) est exclu partout ;
 *  SEL-GEN-007  les documents sensibles sont proposés non cochés ;
 *  Garde-fou    `occupantData: true` (données d'un occupant / ancien locataire) :
 *               jamais rendu, même sélectionné.
 */

import type { DocItem, PhotoItem, PageMap, Nullable } from '../types';
import type { PlannedDoc, GalleryPhoto } from './components';
import { makeUniqueNamer, realExtension, withExtension } from '@/lib/download-filename';

const INTEGRABLE_FORMATS = new Set(['PDF', 'JPG', 'JPEG', 'PNG', 'WEBP']);

interface SelectableLike { selected?: boolean; corrupted?: boolean; occupantData?: boolean }

/** Éléments réellement retenus (SEL-GEN-001, SEL-GEN-006, garde-fou occupant). */
export const selected = <T extends SelectableLike>(list: Nullable<Array<Nullable<T>>>): T[] =>
  (list ?? []).filter((x): x is T => !!x && x.selected === true && !x.corrupted && !x.occupantData);

/** Extensions d'origine compatibles avec le format détecté (`fileFormatOf`). */
const SAME_FORMAT: Record<string, string[]> = {
  jpg: ['jpg', 'jpeg', 'jpe'], heic: ['heic', 'heif'], docx: ['docx', 'doc', 'odt', 'rtf'],
  xlsx: ['xlsx', 'xls', 'ods', 'csv'], pptx: ['pptx', 'ppt', 'odp'], txt: ['txt', 'csv', 'md', 'html', 'htm', 'xml', 'json', 'ics'],
};

/**
 * Nom d'une pièce dans l'archive (ZIP-006/007) — règle COMMUNE du
 * téléchargement (lot 75L, `src/lib/download-filename.ts`) : nom affiché
 * (`title`) + extension du format réel, accents conservés, seuls les
 * caractères interdits retirés ; doublons suffixés « (2) », « (3) »… sans
 * écrasement. Repli : nom d'origine, puis « document ».
 */
export function makeZipNamer(): (doc: { id: string | number; fileName?: Nullable<string>; title?: Nullable<string>; format?: Nullable<string> }, folder?: string) => string {
  const unique = makeUniqueNamer();
  return (doc, folder = 'documents') => {
    const fmt = doc.format ? String(doc.format).toLowerCase() : null;
    const orig = realExtension({ originalFilename: doc.fileName ?? null, mimeType: null });
    const ext = orig && (!fmt || orig === fmt || SAME_FORMAT[fmt]?.includes(orig)) ? orig : (fmt ?? orig);
    const name = withExtension(doc.title ?? '', ext) || withExtension(doc.fileName ?? '', ext) || (ext ? `document.${ext}` : 'document');
    return unique(name, folder);
  };
}

interface AttachmentPlan {
  annexes: PlannedDoc[];
  zip: PlannedDoc[];
  /** Documents retenus d'une section, décorés, dans l'ordre des données. */
  inSection: (section: string) => PlannedDoc[];
  get: (id: string) => PlannedDoc | null;
  /** Référence d'annexe d'un document retenu (« A2 ») ou ''. */
  ref: (id: string) => string;
}

/**
 * Plan des pièces : annexes intégrées numérotées A1… dans l'ordre de `documents[]`
 * (ANN-PDF-001 à 003), liste ZIP (ZIP-001 à 008), et décoration de chaque document
 * (`annexRef` ou `zipPath`) pour les pastilles de destination.
 *  pageMap.annexStart : { A1: 7, … } fourni par le renderer en 2e passe.
 */
export function planAttachments(documents: Nullable<DocItem[]>, pageMap: PageMap | null = null): AttachmentPlan {
  const docs = selected(documents);
  const zipName = makeZipNamer();
  const annexes: PlannedDoc[] = [];
  const zip: PlannedDoc[] = [];
  const byId = new Map<string, PlannedDoc>();
  for (const d of docs) {
    const fmtOk = INTEGRABLE_FORMATS.has(String(d.format ?? '').toUpperCase());
    const pageCount = d.pages ?? 1;
    if (d.mode === 'PDF' && fmtOk) {
      const ref = `A${annexes.length + 1}`;
      const a: PlannedDoc = { ...d, annexRef: ref, pageCount, startPage: pageMap?.annexStart?.[ref] ?? null };
      annexes.push(a);
      byId.set(d.id, a);
    } else if (d.mode === 'ZIP' || d.mode === 'PDF') {
      const z: PlannedDoc = { ...d, zipPath: d.zipPath ?? zipName(d, 'documents') };
      zip.push(z);
      byId.set(d.id, z);
    }
  }
  return {
    annexes,
    zip,
    inSection: (section) => docs.filter((d) => d.section === section).map((d) => byId.get(d.id)).filter((x): x is PlannedDoc => !!x),
    get: (id) => byId.get(id) ?? null,
    ref: (id) => byId.get(id)?.annexRef ?? '',
  };
}

/** Photos retenues, dans l'ordre, avec chemin résolu. */
export const selectedPhotos = (photos: Nullable<PhotoItem[]>, asset: (file: string) => string | null): GalleryPhoto[] =>
  selected(photos).map((p) => ({ ...p, src: asset(p.file) ?? '' }));
