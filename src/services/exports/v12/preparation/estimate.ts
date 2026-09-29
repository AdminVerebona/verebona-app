/**
 * Estimation d'un dossier avant génération — CDC V12 §5.2 (PREP-ESTIMATE),
 * §6.3 (seuils), §17.1 (`estimate`), ZIP-001, ALT-002, ALT-003.
 *
 * Même calcul pour l'écran (`POST …/exports/estimate`) et pour la demande de
 * génération (`enqueue.ts`) : un dossier que l'écran annonce générable n'est
 * pas refusé ensuite, et inversement. Fonction PURE des données du bien et
 * des choix (aucun accès base ni stockage).
 */

import type { DossierCode } from '@/services/exports/catalog';
import type { ExportSource, SourceDocument, SourcePhoto } from '../data/source';
import { planSelection, type ExportChoices, type OutputFormat, type SelectionPlan } from '../data/choices';
import { evaluateThresholds, estimatePages, THRESHOLDS, type ThresholdAlert, type ThresholdInput } from '../thresholds';
import { maxFileBytes } from '../render/media';
import { PREP_MESSAGES } from './messages';
import type { Compatibility, EstimateDto } from './types';

const KB = 1024;
/** PDF sans pièce : couverture, sections, polices embarquées (mesuré sur les maquettes). */
const PDF_BASE_BYTES = 350 * KB;
/** Une photo est réduite à la taille utile du PDF (sharp) : ~400 Ko au plus. */
const PHOTO_PDF_BYTES = 400 * KB;

/** Fichier inutilisable connu dès la préparation (absent du stockage, trop lourd). */
export function unavailability(f: { s3Key: string | null; sizeBytes: number | null }): Compatibility | null {
  if (!f.s3Key) return 'missing';
  if (f.sizeBytes != null && f.sizeBytes > maxFileBytes()) return 'too_large';
  return null;
}

export const docCompatibility = (d: SourceDocument): Compatibility =>
  unavailability(d) ?? (d.integrable ? 'integrable' : 'zip_only');

export interface SelectionEstimate {
  plan: SelectionPlan;
  outputFormat: OutputFormat;
  dto: EstimateDto;
  thresholds: ThresholdInput;
  warnings: ThresholdAlert[];
  blocking: ThresholdAlert[];
}

/**
 * Estime un dossier.
 *
 * `outputFormat` : format demandé (bouton « Générer le PDF » confirmé :
 * `PDF`, les pièces ZIP sont alors retirées). Absent : format « naturel » de
 * la sélection — ZIP dès qu'une pièce retenue est en mode ZIP (ZIP-001).
 */
export function estimateSelection(code: DossierCode, source: ExportSource, choices: ExportChoices, today: string, opts: { outputFormat?: OutputFormat } = {}): SelectionEstimate {
  // Pièces cochées mais inutilisables : exclues d'emblée (MSG-PREP-005).
  const docById = new Map<number, SourceDocument>(source.documents.map((d) => [d.id, d]));
  const photoById = new Map<number, SourcePhoto>(source.photos.map((p) => [p.id, p]));
  const unavailable: EstimateDto['unavailable'] = [];
  const usable = choices.items.filter((it) => {
    if (!it.selected) return true;
    const d = it.sourceType === 'document' ? docById.get(it.sourceId) : undefined;
    const p = it.sourceType === 'photo' ? photoById.get(it.sourceId) : undefined;
    const f = d ?? p;
    const reason = f ? unavailability(f) : null;
    if (!reason) return true;
    unavailable.push({ key: `${it.sourceType}:${it.sourceId}`, label: d?.title ?? p?.caption ?? `Photo ${it.sourceId}`, reason });
    return false;
  });

  const zipPlan = planSelection(code, source, { ...choices, items: usable, outputFormat: 'ZIP' }, today);
  const natural: OutputFormat = zipPlan.documents.some((d) => d.mode === 'ZIP') || zipPlan.photos.some((p) => p.mode === 'ZIP') ? 'ZIP' : 'PDF';
  const outputFormat = opts.outputFormat ?? natural;
  const plan = outputFormat === 'ZIP' ? zipPlan : planSelection(code, source, { ...choices, items: usable, outputFormat: 'PDF' }, today);

  const pdfDocs = plan.documents.filter((pd) => pd.mode === 'PDF');
  const zipDocs = plan.documents.filter((pd) => pd.mode === 'ZIP');
  const pdfPhotos = plan.photos.filter((pp) => pp.mode === 'PDF');
  const zipPhotos = plan.photos.filter((pp) => pp.mode === 'ZIP');

  const sum = (xs: Array<number | null>) => xs.reduce<number>((s, b) => s + (b ?? 0), 0);
  const thresholds: ThresholdInput = {
    integratedDocuments: pdfDocs.length,
    photos: plan.photos.length,
    totalBytes: sum([...plan.documents.map((pd) => pd.doc.sizeBytes), ...plan.photos.map((pp) => pp.photo.sizeBytes)]),
    pages: estimatePages({
      integratedPdfBytes: pdfDocs.filter((pd) => pd.doc.format === 'PDF').map((pd) => pd.doc.sizeBytes ?? 0),
      integratedImages: pdfDocs.filter((pd) => pd.doc.format !== 'PDF').length,
      photos: pdfPhotos.length,
    }),
  };
  const { warnings, blocking } = evaluateThresholds(thresholds);

  const pdfBytes = PDF_BASE_BYTES + sum(pdfDocs.map((pd) => pd.doc.sizeBytes)) + sum(pdfPhotos.map((pp) => Math.min(pp.photo.sizeBytes ?? PHOTO_PDF_BYTES, PHOTO_PDF_BYTES)));
  const zipBytes = sum(zipDocs.map((pd) => pd.doc.sizeBytes)) + sum(zipPhotos.map((pp) => pp.photo.sizeBytes));

  // Seuil de documents : message contractuel MSG-PREP-004.
  const alert = (a: ThresholdAlert) => ({ code: a.code, type: a.type, message: a.code === 'DOCS_BLOCKING' ? PREP_MESSAGES['MSG-PREP-004'] : a.message });

  const zipOnlyItems = [
    ...zipPlan.documents.filter((pd) => pd.mode === 'ZIP').map((pd) => ({ key: `document:${pd.doc.id}`, label: pd.doc.title })),
    ...zipPlan.photos.filter((pp) => pp.mode === 'ZIP').map((pp) => ({ key: `photo:${pp.photo.id}`, label: pp.photo.caption ?? `Photo ${pp.photo.id}` })),
  ];

  const dto: EstimateDto = {
    outputFormat,
    estimatedPages: thresholds.pages,
    estimatedBytes: pdfBytes + (outputFormat === 'ZIP' ? zipBytes : 0),
    pdfItems: pdfDocs.length + pdfPhotos.length,
    zipItems: outputFormat === 'ZIP' ? zipDocs.length + zipPhotos.length : 0,
    pdfDocuments: pdfDocs.length,
    zipDocuments: zipDocs.length,
    pdfPhotos: pdfPhotos.length,
    zipPhotos: zipPhotos.length,
    events: plan.events.size,
    blocking: blocking.map(alert),
    warnings: warnings.map(alert),
    zipOnlyItems,
    unavailable,
    // MSG-PREP-008 : volume qui allonge la génération.
    longGeneration: thresholds.integratedDocuments > THRESHOLDS.docsWarning || thresholds.totalBytes > THRESHOLDS.bytesWarning || thresholds.pages > 100,
  };
  return { plan, outputFormat, dto, thresholds, warnings, blocking };
}
