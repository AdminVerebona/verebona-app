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

/**
 * Carte #863 (C2) — nature du coût d'une somme de réponses : un montant n'est exhaustif que si chaque part
 * l'est ; une part inconnue, partielle ou sans tarif rend la somme PARTIELLE (minimum), jamais complète.
 */
function sommeStatut(a: AiOperationTrace['costStatus'], b: AiOperationTrace['costStatus']): AiOperationTrace['costStatus'] {
  if (!a) return b;
  if (!b) return a;
  if (a === 'NONE') return b;
  if (b === 'NONE') return a;
  if (a === b) return a;
  const exhaustifs = new Set(['OBSERVED', 'ZERO_REPORTED']);
  if (exhaustifs.has(a) && exhaustifs.has(b)) return 'OBSERVED';
  return 'PARTIAL';
}

function avecStatut(t: AiOperationTrace, statut: AiOperationTrace['costStatus'], inconnues: number): AiOperationTrace {
  return statut ? { ...t, costStatus: statut, costUnknownAttempts: inconnues } : t;
}

export function mergeTrace<T>(
  trace: AiOperationTrace,
  res: AiGatewayResponse<T>,
  operationCode: string,
): AiOperationTrace {
  // Carte #863 (C2) : `totalCostMicros` reste la part CHIFFRÉE ; sa nature (exhaustive ou non) l'accompagne.
  const statut = res.fromCache ? trace.costStatus : sommeStatut(trace.costStatus, res.costStatus);
  return avecStatut({
    traceIds: [...trace.traceIds, res.traceId],
    operationCodes: [...trace.operationCodes, operationCode],
    totalInputTokens: trace.totalInputTokens + res.inputTokens,
    totalOutputTokens: trace.totalOutputTokens + res.outputTokens,
    totalCostMicros: trace.totalCostMicros + res.costMicros,
    totalDurationMs: trace.totalDurationMs + res.durationMs,
    usedFallback: trace.usedFallback || res.usedFallback,
    models: trace.models.includes(res.model) ? trace.models : [...trace.models, res.model],
  }, statut, (trace.costUnknownAttempts ?? 0) + (res.fromCache ? 0 : res.costUnknownAttempts ?? 0));
}

export function combineTraces(...traces: AiOperationTrace[]): AiOperationTrace {
  // Capacités T1 : celles de la dernière trace qui en porte (une par analyse).
  const capacites = [...traces].reverse().find((t) => t.accountCapabilities)?.accountCapabilities;
  const combined = traces.reduce((acc, t) => ({
    traceIds: [...acc.traceIds, ...t.traceIds],
    operationCodes: [...acc.operationCodes, ...t.operationCodes],
    totalInputTokens: acc.totalInputTokens + t.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens + t.totalOutputTokens,
    totalCostMicros: acc.totalCostMicros + t.totalCostMicros,
    totalDurationMs: acc.totalDurationMs + t.totalDurationMs,
    usedFallback: acc.usedFallback || t.usedFallback,
    models: [...new Set([...acc.models, ...t.models])],
  }), emptyTrace());
  // Carte #863 (C2) : nature du coût combinée (une part non exhaustive rend la somme partielle).
  const statut = traces.reduce<AiOperationTrace['costStatus']>((acc, t) => sommeStatut(acc, t.costStatus), undefined);
  const avec = avecStatut(combined, statut, traces.reduce((n, t) => n + (t.costUnknownAttempts ?? 0), 0));
  return capacites ? { ...avec, accountCapabilities: capacites } : avec;
}
