/**
 * Agrégation de la trace technique — CDC §5.5.
 *
 * Chaque étape enrichit la trace : le résultat final porte le coût, la durée et
 * les modèles réellement employés pour l'ensemble de l'analyse, rattachés à
 * l'usage `SOURCE_ANALYSIS` et à ses opérations.
 */
import type { AiGatewayResponse } from '../gateway/types';
import type { AiOperationTrace } from './types';

export function emptyTrace(): AiOperationTrace {
  return {
    traceIds: [], operationCodes: [],
    totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0,
    totalDurationMs: 0, usedFallback: false, models: [],
  };
}

export function mergeTrace<T>(
  trace: AiOperationTrace,
  res: AiGatewayResponse<T>,
  operationCode: string,
): AiOperationTrace {
  return {
    traceIds: [...trace.traceIds, res.traceId],
    operationCodes: [...trace.operationCodes, operationCode],
    totalInputTokens: trace.totalInputTokens + res.inputTokens,
    totalOutputTokens: trace.totalOutputTokens + res.outputTokens,
    totalCostMicros: trace.totalCostMicros + res.costMicros,
    totalDurationMs: trace.totalDurationMs + res.durationMs,
    usedFallback: trace.usedFallback || res.usedFallback,
    models: trace.models.includes(res.model) ? trace.models : [...trace.models, res.model],
  };
}

export function combineTraces(...traces: AiOperationTrace[]): AiOperationTrace {
  return traces.reduce((acc, t) => ({
    traceIds: [...acc.traceIds, ...t.traceIds],
    operationCodes: [...acc.operationCodes, ...t.operationCodes],
    totalInputTokens: acc.totalInputTokens + t.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens + t.totalOutputTokens,
    totalCostMicros: acc.totalCostMicros + t.totalCostMicros,
    totalDurationMs: acc.totalDurationMs + t.totalDurationMs,
    usedFallback: acc.usedFallback || t.usedFallback,
    models: [...new Set([...acc.models, ...t.models])],
  }), emptyTrace());
}
