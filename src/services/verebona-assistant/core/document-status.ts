/**
 * États d'analyse d'un document vus par l'assistant — CDC §12.4, §19.12,
 * §23.1 à §23.4, 37.7.
 *
 * « Information non trouvée », « document trouvé mais information absente »,
 * « document en cours d'analyse » et « échec d'analyse » ne doivent pas être
 * fusionnés dans un simple « aucun résultat » (§12.4). La colonne
 * `asset_files.analysis_state` (pipeline d'analyse V4) est la source :
 *   UPLOADING | UPLOADED | ANALYZING        → en cours d'analyse
 *   ANALYSIS_FAILED                         → échec d'analyse
 *   VALIDATION_REQUIRED | CONFLICT_DETECTED → analysé, à vérifier
 *   ANALYZED                                → analysé
 *   NULL                                    → pas d'analyse (offre Standard)
 */
export type DocumentAnalysisStatus = 'IN_ANALYSIS' | 'ANALYSIS_FAILED' | 'TO_VALIDATE' | 'ANALYZED' | 'NOT_ANALYZED';

export function documentAnalysisStatus(state: string | null | undefined): DocumentAnalysisStatus {
  switch ((state ?? '').toUpperCase()) {
    case 'UPLOADING': case 'UPLOADED': case 'ANALYZING': return 'IN_ANALYSIS';
    case 'ANALYSIS_FAILED': return 'ANALYSIS_FAILED';
    case 'VALIDATION_REQUIRED': case 'CONFLICT_DETECTED': return 'TO_VALIDATE';
    case 'ANALYZED': return 'ANALYZED';
    default: return 'NOT_ANALYZED';
  }
}

/** Libellé court et sans jargon d'un statut (§23.1). */
export const ANALYSIS_STATUS_LABELS: Record<DocumentAnalysisStatus, string | null> = {
  IN_ANALYSIS: 'En cours d’analyse',
  ANALYSIS_FAILED: 'Analyse impossible',
  TO_VALIDATE: 'À vérifier',
  ANALYZED: null,
  NOT_ANALYZED: null,
};

/** Texte imposé du §23.2. */
export const IN_ANALYSIS_MESSAGE =
  'Ce document est encore en cours d’analyse. Certaines informations peuvent ne pas être disponibles immédiatement.';

/**
 * Échec d'analyse (§23.4) : l'état expliqué sans jargon, puis l'orientation
 * vers les actions disponibles (relancer, remplacer, compléter, À traiter).
 */
export function analysisFailedMessage(title: string): string {
  return `L’analyse automatique de « ${title} » n’a pas pu aboutir : je ne peux donc pas y lire d’informations. `
    + 'Vous pouvez relancer l’analyse ou remplacer le fichier depuis le document, compléter les informations manuellement, '
    + 'ou consulter « À traiter ».';
}

/** Document trouvé, information absente (§12.4, §19.12). */
export function foundWithoutInfoMessage(title: string): string {
  return `J’ai trouvé « ${title} », mais l’information demandée n’y figure pas dans ce qui a été extrait du document. `
    + 'Vous pouvez ouvrir le document pour la vérifier.';
}
