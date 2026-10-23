/**
 * Forme JSON d'une exécution métier pour le BO — lot 83C. PUR, sans import
 * serveur : utilisable par les écrans (types et libellés).
 */
import type { BusinessExecution, BusinessNature, BusinessOrigin, BusinessOutcome, BusinessProgress, BusinessTreatment, NativeResult } from './types';
import { NATURE_LABELS, ORIGIN_LABELS, outcomeLabel } from './types';

export interface ExecutionCallsDto {
  calls: number;
  failedCalls: number;
  repairCalls: number;
  costMicros: number | null;
  models: string[];
  usageEventIds: number[];
}

export interface BusinessExecutionDto {
  id: string;
  treatment: BusinessTreatment;
  mode: string | null;
  nature: BusinessNature;
  natureLabel: string;
  origin: BusinessOrigin;
  originLabel: string;
  outcome: BusinessOutcome;
  progress: BusinessProgress | null;
  /** « Réussie », « Non finale — en cours »… */
  label: string;
  native: NativeResult;
  cause: string | null;
  accountId: number | null;
  objectType: string | null;
  objectId: string | null;
  triggeredAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string;
  referenceAt: string;
  resumptions: number;
  previousExecutionId: string | null;
  jobIds: number[];
  reportIds: number[];
  traceIds: string[];
  /** Appels de l'exécution (null : non lus). */
  calls: ExecutionCallsDto | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toExecutionDto(x: BusinessExecution, calls: ExecutionCallsDto | null): BusinessExecutionDto {
  return {
    id: x.id, treatment: x.treatment, mode: x.mode, nature: x.nature, natureLabel: NATURE_LABELS[x.nature],
    origin: x.origin, originLabel: ORIGIN_LABELS[x.origin], outcome: x.outcome, progress: x.progress,
    label: outcomeLabel(x.outcome, x.progress), native: x.native, cause: x.cause, accountId: x.accountId,
    objectType: x.objectType, objectId: x.objectId, triggeredAt: x.triggeredAt.toISOString(), startedAt: iso(x.startedAt),
    finishedAt: iso(x.finishedAt), lastActivityAt: x.lastActivityAt.toISOString(), referenceAt: x.referenceAt.toISOString(),
    resumptions: x.resumptions, previousExecutionId: x.previousExecutionId, jobIds: x.jobIds, reportIds: x.reportIds,
    traceIds: x.traceIds, calls,
  };
}
