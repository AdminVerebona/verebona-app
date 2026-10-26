/**
 * Rattrapages de données du CDC 15 §14 (MIG-01 à MIG-09) — lot 17, volet B.
 * Point d'entrée : `runCdc15Backfill` ; script : `scripts/cdc15-backfill.ts`.
 */
export {
  runCdc15Backfill, restoreCdc15Run, MissingRequirementsError, ConcurrentRunError, acquireBackfillLock,
  type BackfillRunResult,
} from './runner';
export { summarizeRun, formatRunSummary } from './report';
export type { MigStep, Decision } from './types';
