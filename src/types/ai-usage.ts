/**
 * Types TypeScript — Suivi de la consommation IA
 * CDC Verebona V2
 */

// ─── Enums / Literals ────────────────────────────────────────────────────────

type AiOperationCategory =
  | 'document_analysis'
  | 'agenda_extraction'
  | 'enrichissement'
  | 'supplier_detection'
  | 'embedding'
  | 'ocr'
  | 'coherence_check'
  | 'search'
  | 'retroactive';

type AiBusinessResult =
  | 'pending'
  | 'success'
  | 'success_with_warning'
  | 'duplicate'
  | 'error'
  | 'refused_quota'
  | 'refused_security'
  | 'incomplete'
  | 'cancelled';

type AiPipelineStepStatus =
  | 'uploaded'
  | 'queued'
  | 'ocr_running'
  | 'ocr_done'
  | 'extracting'
  | 'extracted'
  | 'enriching'
  | 'enriched'
  | 'agenda_running'
  | 'agenda_done'
  | 'embedding'
  | 'done'
  | 'blocked_security'
  | 'error';

type AiSecurityLockType =
  | 'reanalysis_loop'
  | 'abnormal_consumption'
  | 'aberrant_cost'
  | 'flood'
  | 'repeated_errors'
  | 'cost_drift';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const AI_BUSINESS_RESULT_LABELS: Record<AiBusinessResult, string> = {
  pending: 'En cours',
  success: 'Succès',
  success_with_warning: 'Succès avec avertissement',
  duplicate: 'Doublon',
  error: 'Erreur',
  refused_quota: 'Refus quota',
  refused_security: 'Refus sécurité',
  incomplete: 'Incomplet',
  cancelled: 'Annulé',
};

export const AI_OPERATION_CATEGORY_LABELS: Record<AiOperationCategory, string> = {
  document_analysis: 'Analyse documentaire',
  agenda_extraction: 'Extraction agenda',
  enrichissement: 'Enrichissement',
  supplier_detection: 'Détection fournisseur',
  embedding: 'Embeddings',
  ocr: 'OCR',
  coherence_check: 'Contrôle cohérence',
  search: 'Recherche',
  retroactive: 'Rétroactif',
};

export const AI_SECURITY_LOCK_LABELS: Record<AiSecurityLockType, string> = {
  reanalysis_loop: 'Boucle de réanalyse',
  abnormal_consumption: 'Consommation anormale',
  aberrant_cost: 'Coût aberrant',
  flood: 'Flood requêtes',
  repeated_errors: 'Erreurs répétitives',
  cost_drift: 'Dérive coût provider',
};

export const AI_PIPELINE_STEP_LABELS: Record<AiPipelineStepStatus, string> = {
  uploaded: 'Téléversé',
  queued: 'En attente',
  ocr_running: 'OCR en cours',
  ocr_done: 'OCR terminé',
  extracting: 'Extraction',
  extracted: 'Extrait',
  enriching: 'Enrichissement',
  enriched: 'Enrichi',
  agenda_running: 'Agenda en cours',
  agenda_done: 'Agenda terminé',
  embedding: 'Embeddings',
  done: 'Terminé',
  blocked_security: 'Bloqué (sécurité)',
  error: 'Erreur',
};

// ─── Recherche intelligente ────────────────────────────────────────────────────

type AiSearchResponseMode =
  | 'answer'
  | 'sources_only'
  | 'upgrade_hint'
  | 'blocked_offer'
  | 'blocked_ambiguous'
  | 'no_result';

export const AI_SEARCH_RESPONSE_MODE_LABELS: Record<AiSearchResponseMode, string> = {
  answer: 'Réponse IA',
  sources_only: 'Sources seules',
  upgrade_hint: 'Incitation upgrade',
  blocked_offer: 'Offre non éligible',
  blocked_ambiguous: 'Requête ambiguë',
  no_result: 'Aucun résultat',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formate un coût en micro-euros vers euros lisible */
/**
 * Coût IA lisible. Les coûts sont calculés dans la devise de la grille
 * tarifaire du fournisseur : USD (`calcCostMicros`, catalogue Gemini). Le
 * libellé « € » était faux (revue lot 22) : même devise et même format
 * fr-FR que le plafond IA et les réglages du BO.
 */
export function formatCostMicros(micros: number): string {
  if (!micros) return '0,00 $';
  const usd = micros / 1_000_000;
  if (usd < 0.01) return `< 0,01 $`;
  return `${usd.toLocaleString('fr-FR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} $`;
}

/** Calcule le pourcentage d'un quota (0–100, capped) */
export function quotaPercent(used: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}
