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

export const INTEGRABLE_FORMATS = new Set(['PDF', 'JPG', 'JPEG', 'PNG', 'WEBP']);

interface SelectableLike { selected?: boolean; corrupted?: boolean; occupantData?: boolean }

/** Éléments réellement retenus (SEL-GEN-001, SEL-GEN-006, garde-fou occupant). */
export const selected = <T extends SelectableLike>(list: Nullable<Array<Nullable<T>>>): T[] =>
  (list ?? []).filter((x): x is T => !!x && x.selected === true && !x.corrupted && !x.occupantData);

/** Nom de fichier normalisé (ZIP-007) avec suffixes de collision (ZIP-006). */
export function makeZipNamer(): (doc: { id: string | number; fileName?: Nullable<string>; title?: Nullable<string>; format?: Nullable<string> }, folder?: string) => string {
  const used = new Set<string>();
  return (doc, folder = 'documents') => {
    const raw = doc.fileName ?? doc.title ?? `document-${doc.id}`;
    const dotIdx = raw.lastIndexOf('.');
    const ext = dotIdx > 0 ? raw.slice(dotIdx).toLowerCase() : `.${String(doc.format ?? 'pdf').toLowerCase()}`;
    let base = (dotIdx > 0 ? raw.slice(0, dotIdx) : raw)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[’']/g, '-').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
    // Garde-fou (hors maquette) : un titre sans caractère latin ne donne pas un nom vide.
    if (!base) base = `document-${String(doc.id).replace(/[^a-zA-Z0-9]+/g, '-')}`;
    let name = `${base}${ext}`;
    let n = 2;
    while (used.has(`${folder}/${name}`)) name = `${base}_${n++}${ext}`;
    used.add(`${folder}/${name}`);
    return `${folder}/${name}`;
  };
}

export interface AttachmentPlan {
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
