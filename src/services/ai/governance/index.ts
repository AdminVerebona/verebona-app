/**
 * Usage IA n°5 — Administration et gouvernance de l'IA.
 *
 * ⚠️ INVARIANT DE CE MODULE : le modèle propose, un humain valide, la base
 * conserve. Aucune fonction exportée ici n'écrit dans un fichier de prompt.
 */
export { transition, canTransition, allowedEvents, isTerminal, InvalidTransition } from './state-machine';
export type { TransitionEvent } from './state-machine';

export { computeDiff, renderDiff } from './diff.service';
export type { DiffSummary, DiffLine } from './diff.service';

export { analyzeInstruction, hashContent } from './instruction-analyzer.service';
export type { AnalysisProposal } from './instruction-analyzer.service';

export { activateVersion, rollbackToPrevious, getActiveVersion, listVersions } from './activation.service';
export { runTests } from './test-runner.service';
export { runAllChecks, CHECK_THRESHOLDS } from './checks';

export {
  CORPUS_CATEGORIES, registerCorpusCase, listCorpusCases,
  isCorpusComplete, computeRunSummary,
} from './corpus/corpus-registry';
export type { CorpusCategory, CorpusCase, CorpusRunResult } from './corpus/corpus-registry';

export type {
  ChangeRequestStatus, PromptVersion, ChangeRequest, CheckResult, TestRunReport,
} from './types';
