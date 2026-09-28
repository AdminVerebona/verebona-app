/**
 * Seuils, avertissements et blocages (CDC §6.3, ALT-003, THRESHOLD_BLOCKED).
 *
 * Vérifiés à la demande de génération (estimation) puis après résolution des
 * fichiers (pages réelles) : un dossier au-delà d'un seuil bloquant n'est
 * jamais rendu.
 */

export interface ThresholdInput {
  /** Pièces intégrées au PDF. */
  integratedDocuments: number;
  photos: number;
  /** Octets de toutes les pièces retenues (PDF + ZIP). */
  totalBytes: number;
  /** Pages estimées (ou réelles) du PDF. */
  pages: number;
}

export interface ThresholdAlert {
  code: 'DOCS_WARNING' | 'DOCS_BLOCKING' | 'SIZE_WARNING' | 'SIZE_BLOCKING' | 'PAGES_BLOCKING' | 'PHOTOS_BLOCKING';
  type: 'warning' | 'blocking';
  message: string;
}

const MB = 1024 * 1024;

export const THRESHOLDS = {
  docsWarning: 20,
  docsBlocking: 50,
  bytesWarning: 50 * MB,
  bytesBlocking: 150 * MB,
  pagesBlocking: 300,
  photosBlocking: 100,
} as const;

export function evaluateThresholds(t: ThresholdInput): { warnings: ThresholdAlert[]; blocking: ThresholdAlert[] } {
  const all: ThresholdAlert[] = [];
  if (t.integratedDocuments > THRESHOLDS.docsBlocking) {
    all.push({ code: 'DOCS_BLOCKING', type: 'blocking', message: `Plus de ${THRESHOLDS.docsBlocking} documents intégrés au PDF : joignez-en une partie au ZIP ou réduisez la sélection.` });
  } else if (t.integratedDocuments > THRESHOLDS.docsWarning) {
    all.push({ code: 'DOCS_WARNING', type: 'warning', message: `Plus de ${THRESHOLDS.docsWarning} documents intégrés : la génération sera plus longue et le fichier plus lourd.` });
  }
  if (t.totalBytes > THRESHOLDS.bytesBlocking) {
    all.push({ code: 'SIZE_BLOCKING', type: 'blocking', message: 'Le dossier dépasse 150 Mo : réduisez le contenu sélectionné.' });
  } else if (t.totalBytes > THRESHOLDS.bytesWarning) {
    all.push({ code: 'SIZE_WARNING', type: 'warning', message: 'Le dossier dépasse 50 Mo.' });
  }
  if (t.pages > THRESHOLDS.pagesBlocking) {
    all.push({ code: 'PAGES_BLOCKING', type: 'blocking', message: `Le PDF dépasserait ${THRESHOLDS.pagesBlocking} pages : réduisez le contenu sélectionné.` });
  }
  if (t.photos > THRESHOLDS.photosBlocking) {
    all.push({ code: 'PHOTOS_BLOCKING', type: 'blocking', message: `Plus de ${THRESHOLDS.photosBlocking} photos sélectionnées : réduisez la sélection.` });
  }
  return { warnings: all.filter((a) => a.type === 'warning'), blocking: all.filter((a) => a.type === 'blocking') };
}

/**
 * Pages estimées avant résolution : sections du dossier (≈ 5), photos (4 par
 * page), et pour chaque PDF intégré une page par tranche de 150 Ko (estimation
 * prudente, remplacée par le compte réel après résolution).
 */
export function estimatePages(input: { integratedPdfBytes: number[]; integratedImages: number; photos: number }): number {
  const pdfPages = input.integratedPdfBytes.reduce((s, b) => s + Math.max(1, Math.ceil((b || 0) / (150 * 1024))), 0);
  return 5 + Math.ceil(input.photos / 4) + pdfPages + input.integratedImages;
}
