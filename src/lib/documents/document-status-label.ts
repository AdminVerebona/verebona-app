/**
 * Libellé sobre du statut d'analyse d'un document (tiroir document, desktop et
 * mobile) — lot 89B, demande PO du 25/10/2026 : « Statut : analysé » remplace
 * « Automatique — Analysé ». Pur (testé sans rendu).
 */

/** États d'analyse affichés par le tiroir (`analysisState`). */
type DocumentAnalysisDisplayState =
  | 'UPLOADING' | 'UPLOADED' | 'ANALYZING' | 'ANALYZED'
  | 'CONFLICT_DETECTED' | 'FUSION_SUGGESTED' | 'ANALYSIS_FAILED';

const VALEURS: Record<DocumentAnalysisDisplayState, string> = {
  UPLOADING: 'en file d’attente',
  UPLOADED: 'en file d’attente',
  ANALYZING: 'analyse en cours',
  ANALYZED: 'analysé',
  CONFLICT_DETECTED: 'conflit détecté',
  FUSION_SUGGESTED: 'doublon possible',
  ANALYSIS_FAILED: 'analyse non finalisée',
};

/**
 * Valeur du statut (minuscule, sans préfixe). Un état inconnu n'est pas un
 * échec : il est lu comme « analysé » (règle historique du tiroir).
 */
export function documentStatusValue(state: string | null | undefined, processingStatus?: string | null): string {
  if (state === 'ANALYSIS_FAILED' && processingStatus === 'NEEDS_USER_ACTION') return 'action requise';
  return (state && (VALEURS as Record<string, string>)[state]) || VALEURS.ANALYZED;
}

/** Libellé complet : « Statut : analysé ». */
export function documentStatusLabel(state: string | null | undefined, processingStatus?: string | null): string {
  return `Statut : ${documentStatusValue(state, processingStatus)}`;
}
