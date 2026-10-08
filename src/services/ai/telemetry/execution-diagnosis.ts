/**
 * Diagnostic d'une exécution IA — lot 33D (ticket « rapports d'échec IA
 * diagnostiquables », §9 à §13, §15).
 *
 * Assemble, à partir des appels de la trace (`ai_usage_event`) et de leurs
 * diagnostics (`ai_call_diagnostics`) :
 *   · un rapport PAR APPEL de la cascade (principal, replis, réparations) ;
 *   · le diagnostic de cascade (même signature sur tous les modèles ?) ;
 *   · les compteurs SANS AMBIGUÏTÉ : tentatives du job, appels modèle,
 *     fallbacks modèle, passes de réparation (§11) ;
 *   · le statut TECHNIQUE du job distinct du résultat MÉTIER (§15) ;
 *   · le diagnostic final, construit uniquement sur des constats (§12).
 * Pur : aucune lecture en base (testé).
 */
import type { ExecutionRow } from './execution-log.repository';
import type { StoredCallDiagnostic } from '../gateway/diagnostics/diagnostic.repository';
import { cascadeDiagnosis, finalDiagnosis, type CascadeDiagnosis } from '../gateway/diagnostics/classify';
import { displayCause, emptyControlChain, type CallDiagnostic } from '../gateway/diagnostics/taxonomy';

export interface CallReport {
  callId: number;
  /** `principal`, `fallback 1`, `fallback 2`, `réparation`. */
  label: string;
  rank: string | null;
  model: string | null;
  callKind: 'analysis' | 'repair';
  /** SUCCEEDED / REPAIRED / FAILED. */
  status: CallDiagnostic['outcome'];
  /** `INVALID_OUTPUT / SCHEMA_VALIDATION_FAILED`, `TIMEOUT`… ; null : réussite sans incident. */
  cause: string | null;
  stage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  costMicros: number | null;
  /** Le diagnostic détaillé existe (appels du lot 33 et suivants). */
  diagnostic: CallDiagnostic | null;
  diagnosticId: number | null;
  hasModelOutput: boolean;
  /** Message d'erreur enregistré avec l'appel (traces antérieures au lot 33). */
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ExecutionCounters {
  /** Tentatives du JOB de file (reprises par la file), `null` hors file. */
  jobAttempts: number | null;
  /** Appels modèle d'ANALYSE (principal + replis réellement sollicités). */
  modelCalls: number;
  /** Fallbacks modèle (appels de rang repli). */
  modelFallbacks: number;
  /** Passes de réparation ciblée (sans relecture du document). */
  repairCalls: number;
}

export interface ExecutionResultView {
  /** Statut technique du job (`DONE`, `FAILED`…), `null` hors file. */
  jobStatus: string | null;
  /** Résultat métier (`APPLIED`, `FAILED`… ou déduit des appels). */
  businessResult: string | null;
  /** Cause du résultat métier en échec (`INVALID_OUTPUT / …`). */
  cause: string | null;
  /** DONE technique avec un résultat métier en échec : à lire comme un ÉCHEC. */
  doneButFailed: boolean;
}

export interface ExecutionDiagnosis {
  calls: CallReport[];
  cascade: CascadeDiagnosis;
  counters: ExecutionCounters;
  result: ExecutionResultView;
  finalDiagnosis: string[];
}

const RANK_LABELS: Record<string, string> = { primary: 'principal', fallback_1: 'fallback 1', fallback_2: 'fallback 2' };

/**
 * Diagnostic d'un appel antérieur au lot 33 (aucune ligne de diagnostic) :
 * seul le code enregistré est connu — on ne l'invente pas plus précis.
 */
function legacyDiagnostic(c: ExecutionRow): CallDiagnostic | null {
  if (c.status !== 'error') return null;
  const meta = c.failure;
  return {
    outcome: 'FAILED', callKind: c.callKind ?? 'analysis',
    family: (meta?.family as CallDiagnostic['family']) ?? (c.errorCode === 'INVALID_OUTPUT' ? 'INVALID_OUTPUT' : c.errorCode === 'TIMEOUT' ? 'TIMEOUT' : 'UNKNOWN'),
    subtype: (meta?.subtype as CallDiagnostic['subtype']) ?? (c.errorCode === 'INVALID_OUTPUT' ? 'UNKNOWN' : null),
    stage: (meta?.stage as CallDiagnostic['stage']) ?? null,
    outputReceived: (c.outputTokens ?? 0) > 0,
    error: c.errorMessage ? { message: c.errorMessage } : null,
    issues: [], issueCount: 0, controls: emptyControlChain(),
    provider: { provider: c.provider ?? '', model: c.model ?? '' },
    schema: null, repairs: [], signature: meta?.signature ?? null,
  };
}

export function buildExecutionDiagnosis(p: {
  treatment: string | null;
  calls: ExecutionRow[];
  diagnostics: StoredCallDiagnostic[];
  job: { status: string; attempts: number; businessResult?: string | null; businessResultDetail?: Record<string, unknown> | null } | null;
}): ExecutionDiagnosis {
  const byUsage = new Map(p.diagnostics.filter((d) => d.usageEventId !== null).map((d) => [d.usageEventId!, d]));
  const libres = p.diagnostics.filter((d) => d.usageEventId === null);
  const reports: CallReport[] = p.calls.map((c, i) => {
    const stored = byUsage.get(c.id) ?? libres.find((d) => d.callIndex === i && d.model === c.model) ?? null;
    const diag = stored?.diagnostic ?? legacyDiagnostic(c);
    const kind = stored?.diagnostic.callKind ?? c.callKind ?? 'analysis';
    const status: CallDiagnostic['outcome'] = diag?.outcome ?? (c.status === 'error' ? 'FAILED' : 'SUCCEEDED');
    return {
      callId: c.id,
      label: kind === 'repair' ? `réparation (${RANK_LABELS[c.modelRank ?? ''] ?? 'rang inconnu'})` : RANK_LABELS[c.modelRank ?? ''] ?? (c.usedFallback ? 'fallback' : 'rang inconnu'),
      rank: c.modelRank,
      model: c.model,
      callKind: kind,
      status,
      cause: diag ? displayCause(diag.family, diag.subtype) : null,
      stage: diag?.stage ?? null,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      durationMs: c.durationMs,
      costMicros: c.costMicros,
      diagnostic: diag,
      diagnosticId: stored?.id ?? null,
      hasModelOutput: stored?.hasModelOutput ?? false,
      errorCode: c.errorCode,
      errorMessage: c.errorMessage,
    };
  });

  const analyses = reports.filter((r) => r.callKind === 'analysis');
  const asDiag = (r: CallReport): CallDiagnostic => r.diagnostic ?? {
    outcome: r.status, callKind: r.callKind, family: null, subtype: null, stage: null, outputReceived: (r.outputTokens ?? 0) > 0,
    error: null, issues: [], issueCount: 0, controls: emptyControlChain(), provider: { provider: '', model: r.model ?? '' },
    schema: null, repairs: [], signature: null,
  };
  const cascade = cascadeDiagnosis(analyses.map(asDiag));
  const succeeded = reports.some((r) => r.status !== 'FAILED' && r.callKind === 'analysis');
  const counters: ExecutionCounters = {
    jobAttempts: p.job ? p.job.attempts : null,
    modelCalls: analyses.length,
    modelFallbacks: analyses.filter((r) => r.rank === 'fallback_1' || r.rank === 'fallback_2').length,
    repairCalls: reports.length - analyses.length,
  };
  const lastFailed = [...analyses].reverse().find((r) => r.status === 'FAILED');
  const business = p.job?.businessResult ?? (reports.length === 0 ? null : succeeded ? 'SUCCEEDED' : 'FAILED');
  const detailCause = typeof p.job?.businessResultDetail?.cause === 'string' ? p.job.businessResultDetail.cause : null;
  const result: ExecutionResultView = {
    jobStatus: p.job?.status ?? null,
    businessResult: business,
    cause: business === 'FAILED' ? detailCause ?? lastFailed?.cause ?? null : null,
    doneButFailed: p.job?.status === 'DONE' && business === 'FAILED',
  };
  return {
    calls: reports,
    cascade,
    counters,
    result,
    finalDiagnosis: finalDiagnosis({
      treatment: p.treatment,
      succeeded: business !== 'FAILED' && succeeded,
      calls: reports.map(asDiag),
      businessResult: p.job?.businessResult ?? null,
    }),
  };
}
