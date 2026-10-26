/**
 * Reprise des pièces `rooms` dans `substructures` (décision PO D-G, lot 20).
 * Point d'entrée : `runRoomsMerge` ; script : `scripts/merge-rooms-into-substructures.ts`.
 */
export {
  runRoomsMerge, restoreRoomsMerge, summarizeRoomsMerge, formatRoomsMergeSummary,
  MissingRequirementsError, ConcurrentRunError,
  type MergeResult, type RestoreResult,
} from './runner';
export { parseRoomsMergeArgs } from './cli';
