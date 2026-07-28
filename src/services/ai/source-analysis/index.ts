/**
 * Usage IA n°1 — Analyse unifiée des sources.
 * Point d'entrée unique : `runSourceAnalysis`.
 */
export { runSourceAnalysis } from './pipeline';
export type { RunSourceAnalysisInput, RunSourceAnalysisOutput } from './pipeline';

export { getSourceAdapter, registerSourceAdapter } from './adapters';
export type { SourceAdapter } from './adapters';

export { onSourceAnalyzed, clearSourceAnalyzedHandlers } from './events';
export type { SourceAnalyzedEvent } from './events';

export { registerStreamWriter, broadcast } from './stream/broadcast';

export type {
  SourceInput, SourceType, SourceAnalysisResult, LinkCandidate,
  ExtractedField, AgendaCandidate, AnalysisWarning, AnalysisContext,
} from './types';
