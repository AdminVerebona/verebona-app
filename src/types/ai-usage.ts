/**
 * Types TypeScript — Suivi de la consommation IA
 * CDC Verebona V2
 */

// ─── Enums / Literals ────────────────────────────────────────────────────────

export type AiOperationCategory =
  | 'document_analysis'
  | 'agenda_extraction'
  | 'enrichissement'
  | 'supplier_detection'
  | 'embedding'
  | 'ocr'
  | 'coherence_check'
  | 'search'
  | 'retroactive';

export type AiBusinessResult =
  | 'pending'
  | 'success'
  | 'success_with_warning'
  | 'duplicate'
  | 'error'
  | 'refused_quota'
  | 'refused_security'
  | 'incomplete'
  | 'cancelled';

export type AiPipelineStepStatus =
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

export type AiSecurityLockType =
  | 'reanalysis_loop'
  | 'abnormal_consumption'
  | 'aberrant_cost'
  | 'flood'
  | 'repeated_errors'
  | 'cost_drift';

export type AiAdminActionType =
  | 'modify_quota'
  | 'reset_counter'
  | 'unlock_security'
  | 'change_pipeline'
  | 'force_reanalysis';

export type AiOperationOrigin =
  | 'upload'
  | 'reanalyse'
  | 'daily_enrichment'
  | 'retroactive'
  | 'admin';

export type AiEnvironment = 'production' | 'staging' | 'test';

// ─── API Responses ────────────────────────────────────────────────────────────

/** GET /api/account/ai-usage — affiché dans Mon compte > Abonnement */
export interface AccountAiUsageResponse {
  accountId: number;
  periodYear: number;
  /** Nombre de biens actifs (calculé au niveau compte) */
  assetsCount: number;
  assetsQuota: number;
  /** Documents analysés annuels */
  documentsAnalyzedCount: number;
  documentsAnalyzedQuota: number;
  /** Documents analysés pendant essai */
  trialDocumentsCount: number;
  trialDocumentsQuota: number;
  /** true si >= 90% d'un des quotas */
  shouldShowUpgradeCta: boolean;
  /** true si une action est bloquée */
  isAnyQuotaBlocked: boolean;
  /** Pourcentage de chaque quota (0–100) */
  assetsPercent: number;
  documentsPercent: number;
}

/** Vue globale admin */
export interface AdminAiOverview {
  totalOperationsToday: number;
  totalOperationsThisMonth: number;
  totalCostMicrosThisMonth: number;
  totalCostMicrosToday: number;
  operationsByResult: Record<AiBusinessResult, number>;
  operationsByProvider: Record<string, number>;
  fallbackRate: number;
  activeSecurityLocks: number;
  topCostAccounts: Array<{
    accountId: number;
    accountName: string;
    totalCostMicros: number;
  }>;
}

/** Item liste comptes admin */
export interface AdminAiAccountSummary {
  accountId: number;
  accountName: string;
  planCode: string;
  periodYear: number;
  documentsAnalyzedCount: number;
  documentsAnalyzedQuota: number;
  trialDocumentsCount: number;
  trialDocumentsQuota: number;
  totalCostMicrosThisYear: number;
  lastOperationAt: string | null;
  hasActiveLock: boolean;
}

/** Détail compte admin */
export interface AdminAiAccountDetail extends AdminAiAccountSummary {
  recentOperations: AiOperationSummary[];
  activeSecurityLocks: AiSecurityLockDetail[];
  costByProvider: Record<string, number>;
  costByMonth: Array<{ month: string; costMicros: number }>;
  auditLogs: AiAdminAuditEntry[];
}

/** Résumé d'une opération IA */
export interface AiOperationSummary {
  id: number;
  publicId: string;
  accountId: number;
  assetFileId: number | null;
  fileName: string | null;
  operationCategory: AiOperationCategory;
  businessResult: AiBusinessResult;
  origin: AiOperationOrigin;
  providerPrimary: string | null;
  usedFallback: boolean;
  totalCostMicros: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number | null;
  isReanalysis: boolean;
  environment: AiEnvironment;
  startedAt: string;
  completedAt: string | null;
}

/** Détail d'une opération IA avec étapes pipeline */
export interface AiOperationDetail extends AiOperationSummary {
  steps: AiPipelineStepDetail[];
  analysisVersions: AiAnalysisVersionSummary[];
  errorCode: string | null;
  errorMessage: string | null;
  warningMessage: string | null;
}

/** Étape de pipeline */
export interface AiPipelineStepDetail {
  id: number;
  stepName: string;
  stepOrder: number;
  provider: string | null;
  model: string | null;
  status: AiPipelineStepStatus;
  isFallback: boolean;
  fallbackReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  durationMs: number | null;
  promptVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  outputPreview: string | null;
  startedAt: string;
  completedAt: string | null;
}

/** Version d'analyse d'un document */
export interface AiAnalysisVersionSummary {
  id: number;
  versionNumber: number;
  analysisDate: string;
  pipelineVersion: string | null;
  businessResult: AiBusinessResult;
  totalCostMicros: number;
  providerUsed: string | null;
  usedFallback: boolean;
  isCurrent: boolean;
}

/** Détail d'un document admin (vue complète) */
export interface AdminAiDocumentDetail {
  assetFileId: number;
  fileName: string;
  accountId: number;
  accountName: string;
  currentAnalysisStatus: AiPipelineStepStatus | null;
  lastAnalyzedAt: string | null;
  analysisVersions: AiAnalysisVersionSummary[];
  operations: AiOperationDetail[];
  totalCostMicros: number;
}

/** Blocage sécurité */
export interface AiSecurityLockDetail {
  id: number;
  accountId: number;
  accountName: string;
  assetFileId: number | null;
  fileName: string | null;
  lockType: AiSecurityLockType;
  triggeredAt: string;
  triggerDetails: string | null;
  isResolved: boolean;
  resolvedAt: string | null;
  resolvedByEmail: string | null;
  resolutionNotes: string | null;
}

/** Entrée audit admin */
export interface AiAdminAuditEntry {
  id: number;
  adminEmail: string;
  actionType: AiAdminActionType;
  targetAccountId: number | null;
  targetFileId: number | null;
  targetLockId: number | null;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
}

// ─── Filtres admin ────────────────────────────────────────────────────────────

export interface AdminAiFilters {
  environment?: AiEnvironment;
  planCode?: string;
  provider?: string;
  model?: string;
  businessResult?: AiBusinessResult;
  origin?: AiOperationOrigin;
  operationCategory?: AiOperationCategory;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  page?: number;
  limit?: number;
}

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

export type AiSearchResponseMode =
  | 'answer'
  | 'sources_only'
  | 'upgrade_hint'
  | 'blocked_offer'
  | 'blocked_ambiguous'
  | 'no_result';

export interface AiSearchLogEntry {
  id: number;
  publicId: string;
  accountId: number;
  accountName?: string;
  queryText: string;
  responseMode: AiSearchResponseMode;
  answerText: string | null;
  sourcesCount: number;
  offerCode: string;
  contextType: string | null;
  contextId: number | null;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  provider: string | null;
  model: string | null;
  businessResult: string;
  blockReason: string | null;
  trackingId: string;
  createdAt: string;
}

export interface AiSearchLogStats {
  totalCount: number;
  totalCostMicros: number;
  avgDurationMs: number;
  answerCount: number;
  noResultCount: number;
  upgradeHintCount: number;
  errorCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

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
export function formatCostMicros(micros: number): string {
  if (!micros) return '0,00 €';
  const euros = micros / 1_000_000;
  if (euros < 0.01) return `< 0,01 €`;
  return euros.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/** Calcule le pourcentage d'un quota (0–100, capped) */
export function quotaPercent(used: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}
