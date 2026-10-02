/**
 * Reprise des pièces `rooms` dans `substructures` (décision PO D-G, lot 20).
 * Point d'entrée : `runRoomsMerge` ; script : `scripts/merge-rooms-into-substructures.ts`.
 */
export {
  runRoomsMerge, restoreRoomsMerge, summarizeRoomsMerge, formatRoomsMergeSummary, checkRequirements,
  MissingRequirementsError, ConcurrentRunError, ROOMS_MERGE_LOCK_KEY,
  type MergeOptions, type MergeResult, type MergeChange, type MergeDecision, type RestoreResult, type ReenqueueInput,
} from './runner';
export { parseRoomsMergeArgs, ROOMS_MERGE_HELP, type RoomsMergeArgs } from './cli';
export { normalizeRoomName, chooseSubstructure, fillFromRoom, restoreOrder } from './plan';
