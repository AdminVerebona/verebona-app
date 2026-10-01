/**
 * Rattrapages de données du CDC 15 §14 (MIG-01 à MIG-09) — lot 17, volet B.
 * Point d'entrée : `runCdc15Backfill` ; script : `scripts/cdc15-backfill.ts`.
 */
export {
  runCdc15Backfill, restoreCdc15Run, orderSteps, MissingRequirementsError, ConcurrentRunError, acquireBackfillLock,
  type BackfillOptions, type BackfillRunResult,
} from './runner';
export { summarizeRun, formatRunSummary, loadRun } from './report';
export { MIG_STEPS, ALL_ORDER, type MigStep, type Decision, type ReportEntry } from './types';
