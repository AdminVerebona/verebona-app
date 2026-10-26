/**
 * Qualification administrative des exécutions métier, PAR TRAITEMENT —
 * lot 83C (CDC Pilotage IA V2 §4.2, §10, OP-04 à OP-06, RES-01/02, R17-R22,
 * R39-R43, R58, R61 ; décisions PO du 22/10 n° 04 et 05). PUR : aucune lecture
 * de base, l'instant de référence est injecté.
 *
 * Règles communes :
 *   · l'état natif décide, il est rendu tel quel avec la qualification (OP-04) ;
 *   · « Incomplète » seulement sur un critère OBJECTIF existant (RES-02) ;
 *   · une exécution en attente, en cours ou suspendue est NON FINALE : jamais
 *     un échec par simple durée (OP-06, BO-04) ;
 *   · une abstention légitime, une cible disparue ou un travail remplacé ne
 *     sont pas des échecs (OP-05, R39) ;
 *   · faute de preuve, « non déterminable » — jamais une issue devinée (BO-05).
 */
import type { BusinessOutcome, BusinessProgress, NativeResult, Qualification } from './types';
import { FINAL_OUTCOMES } from './types';

const t = (d: Date | string | null | undefined): number | null => {
  if (d == null) return null;
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(ms) ? ms : null;
};
const asDate = (ms: number): Date => new Date(ms);
/** Plus récente des dates connues (null si aucune). */
export function latest(...ds: Array<Date | string | null | undefined>): Date | null {
  const ms = ds.map(t).filter((x): x is number => x !== null);
  return ms.length ? asDate(Math.max(...ms)) : null;
}

function q(
  outcome: BusinessOutcome, native: NativeResult, cause: string | null, lastActivityAt: Date,
  opts: { progress?: BusinessProgress | null; finishedAt?: Date | null } = {},
): Qualification {
  const finale = FINAL_OUTCOMES.has(outcome);
  return {
    outcome, progress: outcome === 'NOT_FINAL' ? (opts.progress ?? 'PENDING') : null, cause, native,
    finishedAt: finale ? (opts.finishedAt ?? lastActivityAt) : null, lastActivityAt,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Règle temporelle commune (SEM-02, BO-05, R60)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Date retenue pour la période : la FIN (dernier résultat) d'une exécution
 * finale — une exécution démarrée avant la période et terminée pendant y est
 * comptée, une seule fois, avec son issue actuelle ; la dernière activité
 * d'une exécution non finale. Bornes : [from, to[, instants UTC (l'écran
 * affiche en Europe/Paris).
 */
export function referenceAt(x: Pick<Qualification, 'finishedAt' | 'lastActivityAt'>): Date {
  return x.finishedAt ?? x.lastActivityAt;
}

export function inPeriod(x: Pick<Qualification, 'finishedAt' | 'lastActivityAt'>, from: Date, to: Date): boolean {
  const r = referenceAt(x).getTime();
  return r >= from.getTime() && r < to.getTime();
}

// ══════════════════════════════════════════════════════════════════════════
// Travail de file (T1, T3, T4) — états non finaux communs
// ══════════════════════════════════════════════════════════════════════════

export interface JobState {
  id: number;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED' | string;
  attempts: number;
  lastError: string | null;
  businessResult: string | null;
  businessResultDetail: Record<string, unknown> | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  availableAt: Date | string | null;
  /** Report pour plafond de coût du compte (payload). */
  costCapDeferredUntil?: string | null;
  /**
   * Lot 87A (P7, RUN-02) : suspension faute de secours admissible
   * (`payload.aiSuspension`) — cause établie, message, reprise prévue.
   */
  aiSuspension?: { cause: string; message: string | null; until: string | null; count: number; resumedAt: string | null } | null;
}

const jobActivity = (j: JobState): Date => latest(j.finishedAt, j.startedAt, j.createdAt) ?? new Date(0);

/** Non final d'un travail vivant (pur) : en cours, en attente, ou suspendu (reprise / report). */
function jobNotFinal(j: JobState, now: Date): { progress: BusinessProgress; cause: string | null } | null {
  if (j.status === 'RUNNING') return { progress: 'RUNNING', cause: null };
  if (j.status !== 'PENDING') return null;
  const reprise = t(j.availableAt);
  if (j.costCapDeferredUntil) return { progress: 'SUSPENDED', cause: `plafond IA du compte : reprise prévue le ${j.costCapDeferredUntil.slice(0, 10)}` };
  // Lot 87A : suspendue faute de secours admissible (cause explicite, aucune écriture).
  if (j.aiSuspension && !j.aiSuspension.resumedAt) {
    return {
      progress: 'SUSPENDED',
      cause: `AI_SUSPENDED (${j.aiSuspension.cause}) : aucun secours admissible, aucune écriture — reprise automatique depuis un point sûr${reprise !== null && reprise > now.getTime() ? ` à ${asDate(reprise).toISOString()}` : ''}${j.aiSuspension.message ? ` (${j.aiSuspension.message.slice(0, 200)})` : ''}`,
    };
  }
  if (j.attempts > 0) {
    return { progress: 'SUSPENDED', cause: `reprise automatique prévue${reprise !== null && reprise > now.getTime() ? ` à ${asDate(reprise).toISOString()}` : ''}${j.lastError ? ` (${j.lastError.slice(0, 200)})` : ''}` };
  }
  return { progress: 'PENDING', cause: null };
}

const jobNative = (j: JobState): NativeResult => ({
  source: 'ai_job_queue', status: String(j.status), result: j.businessResult,
  detail: { jobId: j.id, attempts: j.attempts, ...(j.businessResultDetail ? { businessResult: j.businessResultDetail } : {}) },
});

// ══════════════════════════════════════════════════════════════════════════
// T1 — document logique (décisions PO 04 et 05)
// ══════════════════════════════════════════════════════════════════════════

export interface T1ReportState {
  id: number;
  /** SUCCESS | PARTIAL | FAILED | NO_CHANGE (constaté en base, lot 58C). */
  status: string;
  createdAt: Date | string;
  /** Étapes en échec (persistance partielle, master…). */
  failedSteps: string[];
  /** Qualité de couverture INSTANTANÉE dans le rapport (entrée COVERAGE). */
  coverageQuality: string | null;
  coverageAnomalies: string[] | null;
}

export interface T1CoverageState {
  qualityState: string;
  anomalies: string[];
  nextRetryAt: Date | string | null;
  updatedAt: Date | string;
  unresolvedUnits?: number;
  uncertainUnits?: number;
  failedUnits?: number;
  droppedFacts?: number;
}

export interface T1Input {
  /** Travaux de file de l'exécution, du plus ancien au plus récent. */
  jobs: JobState[];
  /** Rapports de l'exécution, du plus ancien au plus récent. */
  reports: T1ReportState[];
  /**
   * Couverture COURANTE du document — fournie seulement si cette exécution est
   * la plus récente du document (la couverture ne garde que la dernière
   * analyse ; une exécution plus ancienne est jugée sur l'instantané de son
   * rapport).
   */
  coverage: T1CoverageState | null;
  /** État du document : `analysis_state`, supprimé ? */
  file: { analysisState: string | null; deleted: boolean } | null;
}

/** Libellés des anomalies de complétude (codes de `coverage.ts`). */
const ANOMALIES: Record<string, string> = {
  FACTS_TRUNCATED: 'faits tronqués', PARTIAL_EXTRACTION: 'extraction partielle', FACT_INVALID_DROPPED: 'faits écartés',
  SOURCE_UNIT_FAILED: 'unités en échec', COVERAGE_INCOMPLETE: 'couverture incomplète', PAGE_UNVERIFIED: 'pages non vérifiées',
  PAGE_MISSING: 'pages manquantes', REPAIR_PENDING: 'réparation en attente', REPAIR_EXHAUSTED: 'réparation épuisée',
  NORMALISATION_LOSS: 'pertes de normalisation', SOURCE_UNREADABLE: 'source illisible', COVERAGE_UNVERIFIED: 'couverture non vérifiable',
};
const anomaliesText = (a: string[] | null | undefined): string => (a && a.length ? ` (${a.map((x) => ANOMALIES[x] ?? x).join(', ')})` : '');

/**
 * Qualité T1 → issue (décision PO 05, CDC §4.2, R18, R19, R58) :
 *   COMPLETE                  Réussie — seule une extraction exhaustive et vérifiée l'est ;
 *   COMPLETE_WITH_UNRESOLVED  Incomplète — des informations présentes restent non
 *                             structurées, incertaines ou écartées ; jamais Réussie
 *                             par défaut (PO 05) et jamais Échouée sans omission
 *                             AVÉRÉE (la sortie T1 ne qualifie pas encore ses
 *                             écarts : demande 82B) ;
 *   VERIFICATION_INCOMPLETE   Incomplète — pages ou couverture non vérifiées (R18, R58 :
 *                             un ratio de 100 % ne suffit pas) ;
 *   INCOMPLETE_RETRYABLE      non finale tant qu'une reprise ciblée est programmée,
 *                             Incomplète sinon ;
 *   INCOMPLETE_FINAL          Incomplète — un résultat existe, une partie reste non analysée.
 * Une page vérifiée visuellement est COUVERTE et une information absente du
 * document ne crée pas d'unité non résolue (R19) : aucun de ces deux motifs ne
 * rend Incomplète.
 */
function t1Quality(
  quality: string | null, anomalies: string[] | null, coverage: T1CoverageState | null, now: Date,
): { outcome: BusinessOutcome; progress?: BusinessProgress; cause: string | null } {
  switch (quality) {
    case 'COMPLETE': return { outcome: 'SUCCEEDED', cause: null };
    case 'COMPLETE_WITH_UNRESOLVED': {
      const n = coverage
        ? [coverage.unresolvedUnits ? `${coverage.unresolvedUnits} unité(s) non structurée(s)` : null,
          coverage.uncertainUnits ? `${coverage.uncertainUnits} incertaine(s)` : null,
          coverage.droppedFacts ? `${coverage.droppedFacts} fait(s) écarté(s)` : null].filter(Boolean).join(', ')
        : '';
      return { outcome: 'INCOMPLETE', cause: `T1_UNRESOLVED : extraction non exhaustive${n ? ` — ${n}` : ''}${anomaliesText(anomalies)}` };
    }
    case 'VERIFICATION_INCOMPLETE': return { outcome: 'INCOMPLETE', cause: `T1_VERIFICATION_INCOMPLETE : couverture du document non vérifiée${anomaliesText(anomalies)}` };
    case 'INCOMPLETE_RETRYABLE': {
      const next = t(coverage?.nextRetryAt ?? null);
      if (next !== null) return { outcome: 'NOT_FINAL', progress: 'SUSPENDED', cause: `reprise ciblée programmée${next > now.getTime() ? ` à ${asDate(next).toISOString()}` : ''}${anomaliesText(anomalies)}` };
      return { outcome: 'INCOMPLETE', cause: `T1_INCOMPLETE : partie non analysée, aucune reprise programmée${anomaliesText(anomalies)}` };
    }
    case 'INCOMPLETE_FINAL': return { outcome: 'INCOMPLETE', cause: `T1_INCOMPLETE_FINAL : partie non analysée après reprises${anomaliesText(anomalies)}` };
    default: return { outcome: 'UNDETERMINED', cause: 'couverture du document non mesurée : exhaustivité non démontrable' };
  }
}

export function qualifyT1(i: T1Input, now: Date): Qualification {
  const job = i.jobs.length ? i.jobs[i.jobs.length - 1] : null;
  const rep = i.reports.length ? i.reports[i.reports.length - 1] : null;
  const covAt = i.coverage ? t(i.coverage.updatedAt) : null;
  const lastActivityAt = latest(job ? jobActivity(job) : null, rep?.createdAt, i.coverage?.updatedAt) ?? now;
  const repT = rep ? t(rep.createdAt)! : null;
  const jobT = job ? t(job.createdAt)! : null;
  // Le dernier ÉVÉNEMENT décide : un travail (re)mis en file après le dernier rapport rouvre l'exécution.
  const jobDecide = job !== null && (repT === null || (jobT !== null && jobT >= repT) || job.status === 'RUNNING');

  if (job && jobDecide) {
    const nf = jobNotFinal(job, now);
    if (nf) return q('NOT_FINAL', jobNative(job), nf.cause, lastActivityAt, { progress: nf.progress });
    if (job.status === 'CANCELLED') return q('VOID', jobNative(job), 'travail annulé (administration)', lastActivityAt);
    if (job.businessResult === 'FAILED') {
      const c = job.businessResultDetail?.cause;
      return q('FAILED', jobNative(job), `T1_FAILED : ${typeof c === 'string' ? c : 'analyse impossible'}`, lastActivityAt);
    }
    if (job.status === 'FAILED') return q('FAILED', jobNative(job), `T1_FAILED : ${job.lastError?.slice(0, 300) ?? 'échec définitif du travail'}`, lastActivityAt);
    // DONE sans rapport postérieur : le travail n'a rien analysé (analyse concurrente, contexte invalide).
    const repApres = rep && (t(job.startedAt) === null || repT! >= t(job.startedAt)!);
    if (job.status === 'DONE' && !repApres) {
      if (i.file?.deleted) return q('VOID', jobNative(job), 'document supprimé avant analyse', lastActivityAt);
      return q('VOID', jobNative(job), 'travail clos sans analyse (analyse concurrente ou contexte inexploitable)', lastActivityAt);
    }
  }

  if (!rep) {
    // Aucun rapport (analyse directe antérieure au lot 58C, ou rapport non écrit).
    if (i.file?.analysisState === 'ANALYSIS_FAILED') {
      return q('FAILED', { source: 'asset_files', status: 'ANALYSIS_FAILED' }, 'T1_FAILED : analyse en échec (sans rapport)', lastActivityAt);
    }
    return q('UNDETERMINED', job ? jobNative(job) : { source: 'asset_files', status: String(i.file?.analysisState ?? 'inconnu') },
      'aucun rapport d’exécution : issue non démontrable', lastActivityAt);
  }

  const native: NativeResult = {
    source: 'ai_execution_reports', status: rep.status,
    result: i.coverage?.qualityState ?? rep.coverageQuality,
    detail: { reportId: rep.id, ...(job ? { jobId: job.id, jobStatus: job.status } : {}), ...(rep.failedSteps.length ? { failedSteps: rep.failedSteps } : {}) },
  };
  if (rep.status === 'FAILED') {
    return q('FAILED', native, `T1_FAILED : ${rep.failedSteps.length ? `étape(s) en échec ${rep.failedSteps.join(', ')}` : 'aucun résultat exploitable'}`, lastActivityAt);
  }
  // R20 / RES-02 : persistance partielle identifiée, jamais masquée par un succès fournisseur.
  if (rep.status === 'PARTIAL') {
    return q('INCOMPLETE', native, `T1_PERSISTENCE_PARTIAL : écritures incomplètes${rep.failedSteps.length ? ` (${rep.failedSteps.join(', ')})` : ''}`, lastActivityAt);
  }
  const useCov = i.coverage && (covAt ?? 0) >= (repT ?? 0) ? i.coverage : null;
  const quality = useCov?.qualityState ?? rep.coverageQuality;
  const anomalies = useCov?.anomalies ?? rep.coverageAnomalies;
  const r = t1Quality(quality, anomalies, useCov ?? i.coverage, now);
  return q(r.outcome, native, r.cause, lastActivityAt, { progress: r.progress ?? null });
}

// ══════════════════════════════════════════════════════════════════════════
// T3 — travail de réconciliation (R20, R39)
// ══════════════════════════════════════════════════════════════════════════

export interface T3ReportState { id: number; status: string; createdAt: Date | string; failedSteps: string[] }

export function qualifyT3(job: JobState, reports: T3ReportState[], now: Date): Qualification {
  const rep = reports.length ? reports[reports.length - 1] : null;
  const lastActivityAt = latest(jobActivity(job), rep?.createdAt) ?? now;
  const native = { ...jobNative(job), ...(rep ? { detail: { ...jobNative(job).detail, reportId: rep.id, reportStatus: rep.status } } : {}) };
  const nf = jobNotFinal(job, now);
  if (nf) return q('NOT_FINAL', native, nf.cause, lastActivityAt, { progress: nf.progress });
  if (job.status === 'CANCELLED') return q('VOID', native, 'travail annulé (administration)', lastActivityAt);
  if (job.status === 'FAILED') return q('FAILED', native, `T3_FAILED : ${job.lastError?.slice(0, 300) ?? 'échec définitif du travail'}`, lastActivityAt);
  // R20 : écritures obligatoires en échec (rapport T3 constaté en base) — jamais un faux succès.
  if (rep?.status === 'FAILED') return q('FAILED', native, `T3_REPORT_FAILED${rep.failedSteps.length ? ` : ${rep.failedSteps.join(', ')}` : ''}`, lastActivityAt);
  if (rep?.status === 'PARTIAL') return q('INCOMPLETE', native, `T3_PERSISTENCE_PARTIAL : écritures incomplètes${rep.failedSteps.length ? ` (${rep.failedSteps.join(', ')})` : ''}`, lastActivityAt);
  switch (job.businessResult) {
    case 'APPLIED': case 'NO_CHANGE': return q('SUCCEEDED', native, null, lastActivityAt);
    // OP-05 : abstention (conflit ouvert, preuve insuffisante) = issue métier valide.
    case 'ABSTAIN': return q('SUCCEEDED', native, null, lastActivityAt);
    case 'SUPERSEDED': return q('VOID', native, 'remplacé par un travail plus récent', lastActivityAt);
    case 'TARGET_GONE': return q('VOID', native, 'cible disparue depuis la mise en file', lastActivityAt);
    case 'FAILED': {
      const f = job.businessResultDetail?.failure;
      return q('FAILED', native, `T3_FAILED${typeof f === 'string' ? ` : ${f}` : ''}`, lastActivityAt);
    }
    default: return q('UNDETERMINED', native, 'travail terminé sans résultat métier', lastActivityAt);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// T4 — travail Agenda (R40, R41)
// ══════════════════════════════════════════════════════════════════════════

/** Codes des échecs T4 « incomplets » (décisions valides appliquées, lacune reprise : lot 71E/75F). */
const T4_INCOMPLETE_CODES = ['T4_INCOMPLETE', 'T4_PERSIST_PARTIAL', 'T4_SYNC_FAILED'] as const;
const t4Code = (e: string | null): string | null => T4_INCOMPLETE_CODES.find((c) => (e ?? '').includes(c)) ?? null;

export function qualifyT4(job: JobState, now: Date): Qualification {
  const lastActivityAt = jobActivity(job);
  const native = jobNative(job);
  const nf = jobNotFinal(job, now);
  if (nf) return q('NOT_FINAL', native, nf.cause, lastActivityAt, { progress: nf.progress });
  if (job.status === 'CANCELLED') return q('VOID', native, 'travail annulé (administration)', lastActivityAt);
  if (job.status === 'FAILED') {
    // CDC §4.2 T4 : décision manquante ou persistance / synchronisation partielle après les reprises = Incomplète.
    const code = t4Code(job.lastError);
    if (code) return q('INCOMPLETE', native, `${code} : ${job.lastError?.slice(0, 300)}`, lastActivityAt);
    return q('FAILED', native, `T4_FAILED : ${job.lastError?.slice(0, 300) ?? 'tâche inexécutable'}`, lastActivityAt);
  }
  switch (job.businessResult) {
    // Chaque candidat a une issue autorisée ; ABSTAIN = abstention du modèle (date indéterminable, R41), issue valide.
    case 'APPLIED': case 'NO_CHANGE': case 'ABSTAIN': return q('SUCCEEDED', native, null, lastActivityAt);
    case 'SUPERSEDED': return q('VOID', native, 'remplacé par un travail plus récent', lastActivityAt);
    case 'TARGET_GONE': return q('VOID', native, 'cible disparue depuis la mise en file', lastActivityAt);
    case 'FAILED': return q('FAILED', native, 'T4_FAILED', lastActivityAt);
    // Travail ignoré (sans bien ni candidat exploitable, réanalyse vide dégradée) : rien à décider.
    default: return q('VOID', native, 'travail sans candidat exploitable (ignoré)', lastActivityAt);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// T2 — demande de l'assistant (R21)
// ══════════════════════════════════════════════════════════════════════════

interface T2RunState {
  requestId: string;
  /** pending | ok | error | cancelled */
  status: string | null;
  machineFinalState: string | null;
  mode: string | null;
  errorCode: string | null;
  createdAt: Date | string;
  latencyMs: number | null;
  /** Niveau d'étayage de la réponse enregistrée (supported, partial, insufficient, conflicting). */
  supportLevel: string | null;
}

/**
 * Au-delà, une demande `pending` n'est plus vivante (traitement interrompu) :
 * même borne que la réservation (`staleAfterMs` = délai total + 10 s).
 */
export function qualifyT2(r: T2RunState, now: Date, staleAfterMs: number): Qualification {
  const created = t(r.createdAt) ?? now.getTime();
  const fin = asDate(created + Math.max(0, r.latencyMs ?? 0));
  const native: NativeResult = {
    source: 'verebona_request_runs', status: String(r.status ?? 'inconnu'), result: r.machineFinalState,
    detail: { mode: r.mode, supportLevel: r.supportLevel, ...(r.errorCode ? { errorCode: r.errorCode } : {}) },
  };
  if (r.status === 'pending') {
    if (now.getTime() - created < staleAfterMs) return q('NOT_FINAL', native, null, asDate(created), { progress: 'RUNNING' });
    return q('UNDETERMINED', native, 'demande jamais close (traitement interrompu) : issue inconnue', asDate(created));
  }
  if (r.status === 'cancelled' || r.machineFinalState === 'CANCELLED') return q('VOID', native, 'demande annulée par l’utilisateur', fin);
  if (r.status === 'error' || r.machineFinalState === 'ERROR_FINAL' || r.machineFinalState === 'ERROR_RECOVERABLE') {
    return q('FAILED', native, `T2_FAILED : ${r.errorCode ?? r.machineFinalState ?? 'aucune réponse exploitable'}`, fin);
  }
  if (r.status !== 'ok') return q('UNDETERMINED', native, 'statut de demande inconnu', fin);
  // Contrôle OBJECTIF existant : la validation a écarté des affirmations non étayées (§12.4, `computeSupportLevel`).
  if (r.supportLevel === 'partial') return q('INCOMPLETE', native, 'T2_CLAIMS_DISCARDED : affirmations écartées par la validation des preuves', fin);
  // supported ; insufficient / conflicting = abstention ou conflit signalés, sans affirmation non étayée (OP-05) ;
  // clarification = question posée en retour. Critères d'« Incomplète » propres au contrat T2 : demande 83C-t2.
  return q('SUCCEEDED', native, null, fin);
}

// ══════════════════════════════════════════════════════════════════════════
// T6 — FORMULATE (génération) et EVALUATE (évaluation) : R42, R43
// ══════════════════════════════════════════════════════════════════════════

interface T6FormulateState {
  traceId: string;
  /** generated | validation_failed | error (lignes portant une trace d'appel) */
  status: string;
  mode: string;
  error: string | null;
  createdAt: Date | string;
  /**
   * Lot 87C : trace des questions suggérées de la génération
   * (`suggestion_report`, 0756) — contrat, produites / acceptées / rejetées,
   * motifs, invalidations postérieures. Absente : génération antérieure.
   */
  suggestionReport?: Record<string, unknown> | null;
}

/** Lot 87C — résumé BO des questions d'une génération (pur) : nombres et motifs, jamais de texte. */
function t6SuggestionSummary(r: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!r || typeof r !== 'object') return null;
  const inv = Array.isArray(r.invalidations) ? r.invalidations as Array<{ removed?: unknown; source?: unknown; at?: unknown; reasons?: unknown }> : [];
  return {
    contract: r.contract ?? null, promptSupported: r.promptSupported ?? null,
    produced: r.produced ?? 0, accepted: r.accepted ?? 0, rejected: r.rejected ?? 0, reasons: r.reasons ?? {},
    invalidated: inv.reduce((n, x) => n + (typeof x.removed === 'number' ? x.removed : 0), 0),
    invalidations: inv.slice(-10).map((x) => ({ at: x.at ?? null, source: x.source ?? null, reasons: x.reasons ?? {}, removed: x.removed ?? 0 })),
  };
}

/** Lot 87C — résultat natif lisible au BO (« questions : 1 acceptée, 2 rejetées [motifs] ») — pur. */
function t6SuggestionResultText(s: Record<string, unknown>): string {
  if (s.promptSupported === false) return 'questions : prompt sans contrat des questions fondées (aucune publiée)';
  const motifs = Object.keys((s.reasons as Record<string, number> | null) ?? {}).sort().join(', ');
  const retirees = Number(s.invalidated ?? 0);
  return `questions : ${Number(s.accepted ?? 0)} acceptée(s), ${Number(s.rejected ?? 0)} rejetée(s)${motifs ? ` [${motifs}]` : ''}${retirees ? `, ${retirees} retirée(s) ensuite` : ''}`;
}

export function qualifyT6Formulate(g: T6FormulateState): Qualification {
  const at = new Date(t(g.createdAt) ?? 0);
  // Lot 87C : une génération réussie ne masque pas ses questions rejetées ou retirées
  // (résultat natif) ; aucune question n'est pas un échec — l'issue reste celle de la bulle.
  const questions = t6SuggestionSummary(g.suggestionReport);
  const native: NativeResult = {
    source: 'home_mascot_generations', status: g.status,
    ...(questions ? { result: t6SuggestionResultText(questions) } : {}),
    detail: { mode: g.mode, ...(questions ? { suggestions: questions } : {}) },
  };
  switch (g.status) {
    case 'generated': return q('SUCCEEDED', native, null, at);
    // R42 : le texte déterministe assure la continuité, l'échec de génération reste un échec.
    case 'validation_failed': return q('FAILED', native, `T6_FORMULATE_INVALID : ${g.error?.slice(0, 300) ?? 'sortie rejetée'} (texte de secours affiché)`, at);
    case 'error': return q('FAILED', native, `T6_FORMULATE_ERROR : ${g.error?.slice(0, 300) ?? 'erreur'} (texte de secours affiché)`, at);
    default: return q('UNDETERMINED', native, `statut de génération ${g.status}`, at);
  }
}

interface T6EvaluateState {
  agendaItemId: number;
  status: string;
  attempts: number;
  requestedAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  updatedAt: Date | string;
  leaseUntil: Date | string | null;
  nextAttemptAt: Date | string | null;
  lastErrorKind: string | null;
  lastError: string | null;
  lastOutcome: string | null;
  mode: string | null;
}

export function qualifyT6Evaluate(r: T6EvaluateState, now: Date): Qualification {
  const lastActivityAt = latest(r.updatedAt, r.finishedAt, r.startedAt, r.requestedAt) ?? now;
  const native: NativeResult = {
    source: 't6_evaluation_runs', status: r.status, result: r.lastOutcome,
    detail: { agendaItemId: r.agendaItemId, attempts: r.attempts, ...(r.lastErrorKind ? { errorKind: r.lastErrorKind } : {}) },
  };
  const finished = latest(r.finishedAt) ?? lastActivityAt;
  switch (r.status) {
    case 'PENDING': return q('NOT_FINAL', native, null, lastActivityAt, { progress: 'PENDING' });
    case 'RUNNING': {
      const bail = t(r.leaseUntil);
      return bail !== null && bail < now.getTime()
        ? q('NOT_FINAL', native, 'exécution interrompue (bail expiré) : reprise au passage suivant', lastActivityAt, { progress: 'SUSPENDED' })
        : q('NOT_FINAL', native, null, lastActivityAt, { progress: 'RUNNING' });
    }
    case 'RETRY_WAIT': case 'UNAVAILABLE':
      return q('NOT_FINAL', native, `${r.lastErrorKind ?? 'nouvel essai'} : nouvel essai prévu${r.nextAttemptAt ? ` à ${new Date(t(r.nextAttemptAt)!).toISOString()}` : ''}`, lastActivityAt, { progress: 'SUSPENDED' });
    case 'COMPLETED': return q('SUCCEEDED', native, null, lastActivityAt, { finishedAt: finished });
    case 'FAILED': return q('FAILED', native, `T6_EVALUATE_${String(r.lastErrorKind ?? 'failed').toUpperCase()}${r.lastError ? ` : ${r.lastError.slice(0, 300)}` : ''}`, lastActivityAt, { finishedAt: finished });
    default: return q('UNDETERMINED', native, `statut d’évaluation ${r.status}`, lastActivityAt);
  }
}
