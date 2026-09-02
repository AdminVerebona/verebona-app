export {
  computeHash,
  isUnchanged,
  recordVersion,
  getVersion,
  markVerified,
} from './version-tracker.service';
export type { ObjectType } from './version-tracker.service';

export {
  resolveImpacts,
  resolveImpactChain,
  getDependents,
  getDependenciesFor,
  addDependency,
  getAllTriggerTypes,
  clearDependencyCache,
  TRIGGER_CATEGORIES,
} from './field-dependency.service';
export type { ImpactType, Confidence, DependencyRule } from './field-dependency.service';

export {
  enqueue,
  enqueueBatch,
  enqueueForAiReview,
  hasPendingAiReviewForAsset,
  dequeue,
  dequeueBatch,
  dequeueAiReviewItems,
  hasAiReviewItems,
  complete,
  fail,
  skip,
  getQueueStats,
  recoverStaleItems,
} from './impact-queue.service';
export type { ImpactStatus, TriggerType, EnqueueImpactInput, ImpactQueueItem } from './impact-queue.service';

export {
  processImpact,
  processPendingImpacts,
  emitDocumentAnalyzed,
  emitUserFieldEdit,
  emitAssetUpdated,
  emitAgendaItemCreated,
  emitManualRePropagation,
} from './impact-propagation.service';
export type { PropagationResult } from './impact-propagation.service';

export {
  createInconsistency,
  resolveInconsistency,
  autoResolveForField,
  getOpenInconsistencies,
  countOpen,
  hasOpenInconsistency,
  determineAction,
} from './inconsistency.service';
export type { InconsistencyType, InconsistencyStatus, InconsistencyEntry } from './inconsistency.service';

export { runNightlyCatchup } from './nightly-catchup.service';
export type { NightlyCatchupResult } from './nightly-catchup.service';
