/**
 * Types partagés front/back — IA documentaire V3.3
 * Toute évolution incompatible impose un bump de schemaVersion.
 */

// ─── AttentionProjection ─────────────────────────────────────────────────────

export const ATTENTION_PROJECTION_SCHEMA_VERSION = 1;

export interface AttentionProjection {
  schemaVersion: number;
  fileId: number;
  predictedAttentionReasons: string[];
  isCommittableAsIs: boolean;
  analysisStatus: LotItemAnalysisStatus;
  confidenceSummary: string;
  lastUpdatedAt: string; // ISO 8601
}

// ─── Proposal ────────────────────────────────────────────────────────────────

export type ProposalType = 'field' | 'link' | 'derived_date' | 'agenda_suggestion';
export type ProposalStatus = 'pending' | 'kept' | 'modified' | 'rejected';

export interface Proposal {
  id: number;
  runId: number;
  assetFileId: number;
  proposalType: ProposalType;
  targetKey: string;
  canonicalCode: string | null;
  displayLabel: string | null;
  proposedValueJson: string;
  confidence: number | null;
  status: ProposalStatus;
  finalValueJson: string | null;
  createdAt: string;
}

// ─── AgendaEffect ─────────────────────────────────────────────────────────────

export type AgendaEffectType = 'created' | 'resolved_existing' | 'conflict_pending' | 'rejected_orphan';

export interface AgendaEffect {
  effectType: AgendaEffectType;
  /** null pour conflict_pending et rejected_orphan */
  agendaItemId: number | null;
  assetFileId: number;
  runId: number;
  metadata?: Record<string, unknown>;
}

// ─── AnalysisRun ──────────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'analyzing' | 'completed' | 'failed' | 'interrupted';

export interface AnalysisRun {
  id: number;
  assetFileId: number;
  lotId: number | null;
  inputFileHash: string;
  promptVersion: string;
  provider: string;
  model: string;
  status: RunStatus;
  isCurrentReference: boolean;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

// ─── TaxonomyMapping ──────────────────────────────────────────────────────────

export type MappingType = 'function_code' | 'date_label';
export type MappingSource = 'gemini' | 'openai' | 'manual';
export type MappingStatus = 'active' | 'inactive';

export interface TaxonomyMapping {
  id: number;
  mappingType: MappingType;
  rawLabel: string;
  canonicalCode: string;
  canonicalLabel: string;
  confidenceThreshold: number;
  source: MappingSource;
  status: MappingStatus;
  createdBy: string | null;
  updatedBy: string | null;
  disabledAt: string | null;
}

// ─── LotItem ─────────────────────────────────────────────────────────────────

export type LotItemAnalysisStatus = 'pending' | 'analyzing' | 'completed' | 'failed';
export type LotItemCommitStatus = 'pending' | 'committed' | 'failed';

export interface LotItem {
  id: number;
  lotId: number;
  assetFileId: number;
  position: number;
  currentAnalysisRunId: number | null;
  analysisStatus: LotItemAnalysisStatus;
  commitStatus: LotItemCommitStatus;
  attentionProjection: AttentionProjection | null;
  confidenceSummary: string | null;
  createdAt: string;
}

// ─── Lot ────────────────────────────────────────────────────────────────────

export type LotStatus = 'draft' | 'uploaded' | 'analyzing' | 'analyzed' | 'committing' | 'committed' | 'partially_failed';

export interface DocumentLot {
  id: number;
  accountId: number;
  label: string | null;
  status: LotStatus;
  items: LotItem[];
  createdAt: string;
  committedAt: string | null;
}

// ─── analyzeDocument contract ─────────────────────────────────────────────────

export interface AnalyzeDocumentInput {
  assetFileId: number;
  /** Grouped files for multi-page documents */
  assetFileIds?: number[];
  lotId?: number;
  lotItemId?: number;
  signedUrl: string;
  /** Grouped URLs for multi-page documents */
  signedUrls?: string[];
  mimeType: string;
  promptVersion: string;
}

export interface AnalyzeDocumentOutput {
  runId: number;
  proposals: Proposal[];
  agendaEffects: AgendaEffect[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostMicros: number;
  modelUsed: string;
  usedFallback: boolean;
  equipmentCandidates?: Array<{ name: string; type: string | null; category: string | null; confidence: number; reason: string }>;
}

// ─── Commit output ────────────────────────────────────────────────────────────

export interface CommitResult {
  committed: boolean;
  appliedFields: string[];
  agendaEffectsProcessed: number;
}
