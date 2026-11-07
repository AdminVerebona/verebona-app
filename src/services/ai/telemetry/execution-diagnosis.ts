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
import { NOT_CALLED_ERROR_CODES, NO_GENERATION_STAGES } from '../gateway/fallback-policy';
import type { ExecutionRow } from './execution-log.repository';
import type { StoredCallDiagnostic } from '../gateway/diagnostics/diagnostic.repository';
import { cascadeDiagnosis, finalDiagnosis, type CascadeDiagnosis } from '../gateway/diagnostics/classify';
import {
  displayCause, displayErrorCode, emptyControlChain, isStructuredOutputRetry, providerFailureCategory,
  type AttachmentTransferFailure, type CallDiagnostic, type ProviderAttemptTrace, type ProviderFailureCategory, type ProviderRequestTrace,
} from '../gateway/diagnostics/taxonomy';

export interface CallReport {
  /** Lot 87 (P7) : rang tracé mais jamais appelé (secours refusé, modèle connu indisponible). */
  notCalled?: boolean;
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
  /**
   * Lot 52B : fournisseur indisponible ≠ requête refusée ≠ structured output
   * refusé (échec avant sortie) ; `null` sinon.
   */
  failureCategory?: ProviderFailureCategory | null;
  /** Lot 52B : requête fournisseur sans contenu, tentatives internes de l'appel. */
  providerRequest?: ProviderRequestTrace | null;
  providerAttempts?: ProviderAttemptTrace[];
  /** Lot 113R : rang CONFIGURÉ (principal, secours 1, secours 2) — distinct du secours réellement utilisé. */
  configuredRank?: string | null;
  /** Lot 113R : un secours a RÉELLEMENT été sollicité à ce rang (jamais vrai pour un rang non appelé). */
  fallbackUsed?: boolean;
  /** Lot 113R : une génération a été demandée au modèle (faux : non appelé, construction locale, transfert). */
  generationRequested?: boolean;
  /** Lot 113R : motif du non-appel (décision de la politique) et dépendance commune réelle. */
  notCalledReason?: string | null;
  commonDependency?: string | null;
  /** Lot 113R : réponse du fournisseur au transfert de la pièce jointe (sans secret), `null` sinon. */
  transfer?: AttachmentTransferFailure | null;
}

export interface ExecutionCounters {
  /** Tentatives du JOB de file (reprises par la file), `null` hors file. */
  jobAttempts: number | null;
  /** Appels modèle d'ANALYSE (principal + replis réellement sollicités). */
  modelCalls: number;
  /** Fallbacks modèle (appels de rang repli). */
  modelFallbacks: number;
  /**
   * Lot 52B : nouveaux essais du MÊME modèle sans structured output (refus
   * explicite du schéma ou essai diagnostique après un 400 générique). Ni
   * fallback modèle, ni tentative du job, ni réparation.
   */
  structuredOutputRetries: number;
  /** Passes de réparation ciblée (sans relecture du document). */
  repairCalls: number;
  /** Lot 113R : rangs tracés mais NON appelés (refus de secours, modèle connu indisponible). */
  notCalled?: number;
  /** Lot 113R : appels arrêtés au transfert de la pièce jointe (aucune génération). */
  transferFailures?: number;
  /** Lot 113R : générations réellement demandées au modèle (analyse, hors transfert et construction locale). */
  generationsRequested?: number;
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

/** Lot 87 (P7, 87A) : codes d'un rang SAUTÉ par la politique de secours (tracé, jamais appelé). */
const NOT_CALLED_CODES: ReadonlySet<string> = NOT_CALLED_ERROR_CODES;

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
    const notCalled = NOT_CALLED_CODES.has(c.errorCode ?? '');
    const decision = c.fallbackDecision ?? null;
    const stage = diag?.stage ?? c.failure?.stage ?? null;
    return {
      notCalled,
      configuredRank: c.modelRank,
      fallbackUsed: !notCalled && (c.modelRank === 'fallback_1' || c.modelRank === 'fallback_2' || (c.modelRank == null && c.usedFallback)),
      generationRequested: !notCalled && !NO_GENERATION_STAGES.has(String(stage ?? '')),
      notCalledReason: notCalled ? (typeof decision?.decisionLabel === 'string' ? decision.decisionLabel : 'non appelé (politique de secours)') : null,
      commonDependency: typeof decision?.commonDependency === 'string' ? decision.commonDependency : null,
      transfer: c.transfer ?? diag?.transfer ?? null,
      callId: c.id,
      label: kind === 'repair' ? `réparation (${RANK_LABELS[c.modelRank ?? ''] ?? 'rang inconnu'})` : RANK_LABELS[c.modelRank ?? ''] ?? (c.usedFallback ? 'fallback' : 'rang inconnu'),
      rank: c.modelRank,
      model: c.model,
      callKind: kind,
      status,
      cause: notCalled ? 'non appelé (politique de secours)' : diag ? displayCause(diag.family, diag.subtype) : null,
      stage: diag?.stage ?? null,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      durationMs: c.durationMs,
      costMicros: c.costMicros,
      diagnostic: diag,
      diagnosticId: stored?.id ?? null,
      hasModelOutput: stored?.hasModelOutput ?? false,
      errorCode: displayErrorCode(c.errorCode, diag?.family ?? c.failure?.family, diag?.subtype ?? c.failure?.subtype),
      errorMessage: c.errorMessage,
      failureCategory: !notCalled && diag && !diag.outputReceived ? providerFailureCategory(diag.family, diag.subtype, diag.stage) : null,
      providerRequest: c.providerRequest ?? null,
      providerAttempts: c.providerAttempts ?? [],
    };
  });

  // Un rang sauté par la politique de secours n'est ni un appel ni un échec de modèle.
  const appels = reports.filter((r) => !r.notCalled);
  const analyses = appels.filter((r) => r.callKind === 'analysis');
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
    structuredOutputRetries: analyses.reduce((n, r) => n + (r.providerAttempts ?? []).filter(isStructuredOutputRetry).length, 0),
    repairCalls: appels.length - analyses.length,
    notCalled: reports.length - appels.length,
    transferFailures: analyses.filter((r) => r.diagnostic?.stage === 'attachment_transfer').length,
    generationsRequested: analyses.filter((r) => r.generationRequested).length,
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
    finalDiagnosis: [
      ...finalDiagnosis({
        treatment: p.treatment,
        succeeded: business !== 'FAILED' && succeeded,
        calls: appels.map(asDiag),
        businessResult: p.job?.businessResult ?? null,
      }),
      ...structuredRetryLines(analyses),
    ],
  };
}

/**
 * Lot 52B — constats sur les essais sans structured output, construits
 * uniquement à partir des tentatives tracées (aucune hypothèse).
 */
function structuredRetryLines(calls: Array<Pick<CallReport, 'model' | 'providerAttempts'>>): string[] {
  const lines: string[] = [];
  for (const c of calls) {
    const attempts = c.providerAttempts ?? [];
    const retry = attempts.find(isStructuredOutputRetry);
    if (!retry) continue;
    const first = attempts.find((a) => a.kind === 'initial');
    const refus = first ? `HTTP ${first.httpStatus ?? '?'}${first.providerErrorCode && first.providerErrorCode !== String(first.httpStatus) ? ` ${first.providerErrorCode}` : ''}` : 'refus';
    const schema = first?.providerSchemaHash ? ` (schéma fournisseur ${first.providerSchemaHash})` : '';
    if (retry.kind === 'schema_rejected_retry') {
      lines.push(`${c.model ?? 'Modèle'} : structured output refusé explicitement${schema} — nouvel essai du même modèle sans responseSchema : ${retry.outcome === 'SUCCESS' ? 'réponse reçue' : 'échec'}.`);
    } else if (retry.outcome === 'SUCCESS') {
      lines.push(`${c.model ?? 'Modèle'} : ${refus} avec structured output${schema} ; essai diagnostique du même modèle sans responseSchema réussi — le structured output est la cause, refus mémorisé, aucun fallback modèle nécessaire.`);
    } else {
      lines.push(`${c.model ?? 'Modèle'} : ${refus} avec structured output${schema} ; essai diagnostique sans responseSchema également en échec (HTTP ${retry.httpStatus ?? '?'}) — le schéma n’est pas mis en cause.`);
    }
  }
  return lines;
}
