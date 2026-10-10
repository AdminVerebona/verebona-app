/**
 * Tentatives d'un job de file et mécanisme de retry — lot 34C (ticket « ne
 * plus exposer les erreurs techniques IA aux utilisateurs et fiabiliser leur
 * suivi dans BO › Exécutions IA »). Complète le diagnostic du lot 33D
 * (`execution-diagnosis`), sans le dupliquer : les rapports d'appel de
 * chaque tentative sont ceux de `buildExecutionDiagnosis`.
 *
 * Deux niveaux, jamais confondus :
 *   · TENTATIVES DU JOB — exécutions successives du job par la file
 *     (`ai_job_queue.attempts`, historique `attempt_history`, migration 0288) ;
 *   · APPELS MODÈLE d'une tentative — la cascade principal → fallback 1 →
 *     fallback 2 (et réparations), regroupée par `metadata.jobAttempt`.
 *
 * « 2 tentatives × 3 modèles » se lit « Tentatives du job : 2 », chacune
 * avec ses 3 appels — jamais « 6 tentatives » (cas 6).
 *
 * Le retry n'est JAMAIS supposé : il est lu sur l'état du job (PENDING après
 * un échec = nouvelle tentative réellement en file) et sur l'historique écrit
 * après chaque clôture (`retryScheduled`). Pur : aucune lecture en base.
 */
import type { ExecutionRow } from './execution-log.repository';
import type { StoredCallDiagnostic } from '../gateway/diagnostics/diagnostic.repository';
import { buildExecutionDiagnosis, type CallReport } from './execution-diagnosis';

/** Entrée de `ai_job_queue.attempt_history` (migration 0288). */
export interface AttemptHistoryEntry {
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  outcome: 'done' | 'failed' | 'interrupted' | 'deferred' | 'abandoned';
  businessResult?: string | null;
  error?: string | null;
  timedOut?: boolean;
  retryScheduled?: boolean;
  nextAttemptAt?: string | null;
  statusAfter?: string | null;
}

/** Résultat d'une tentative du job. */
export type AttemptStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'INTERRUPTED' | 'DEFERRED' | 'ABANDONED';

export interface JobAttemptView {
  attempt: number;
  status: AttemptStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** Cascade de modèles de CETTE tentative (rapports du lot 33D). */
  calls: CallReport[];
  /** Appels modèle d'analyse de la tentative (principal + replis sollicités). */
  modelCalls: number;
  /**
   * Appel en cours (job RUNNING, tentative courante) : rang suivant de la
   * cascade après le dernier appel en échec (« Fallback 1 : RUNNING »).
   */
  runningCall: { label: string; rank: string } | null;
  /** Cause de l'échec (famille / sous-type de la cascade, sinon motif enregistré). */
  cause: string | null;
  /** Motif technique enregistré à la clôture de la tentative (BO seulement). */
  technicalError: string | null;
  /** Une nouvelle tentative a été réellement planifiée après celle-ci (`null` : inconnu, historique antérieur au lot 34). */
  retryScheduled: boolean | null;
  nextAttemptAt: string | null;
}

export type RetryState = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface JobRetryView {
  /** Tentative courante du job (en cours, à venir, ou dernière). */
  currentAttempt: number;
  /** Plafond d'exécutions de la file (MOD-005), `null` si sans objet. */
  maxAttempts: number | null;
  /** Le mécanisme de retry automatique est intervenu (ou intervient) pour ce job. */
  automatic: boolean;
  /** État du retry, `null` sans retry. */
  state: RetryState | null;
  /** Une nouvelle tentative attend réellement en file. */
  scheduled: boolean;
  /** Motif du retry : cause de la tentative en échec qui l'a provoqué. */
  reason: string | null;
  /** Prochaine tentative : date ISO, `IMMEDIATE`, ou `null`. */
  nextAttempt: string | 'IMMEDIATE' | null;
  /** Règle de retry propre au traitement, quand elle diffère du plafond. */
  policy: string | null;
}

export interface JobExecutionView {
  jobId: number;
  /** Statut TECHNIQUE du job (DONE = le worker a terminé, pas une réussite). */
  jobStatus: string;
  /** Résultat MÉTIER (APPLIED, FAILED…), `null` si non clos ou sans résultat. */
  businessResult: string | null;
  /** Tentatives du job réellement exécutées (exécutions consommées). */
  attemptsCount: number;
  /** Historique, dans l'ordre, chaque tentative avec sa propre cascade. */
  attempts: JobAttemptView[];
  retry: JobRetryView;
  /** Les appels n'ont pas pu être rattachés à une tentative (traces antérieures au lot 34). */
  legacyCalls: CallReport[];
}

const NEXT_RANK: Record<string, { label: string; rank: string } | null> = {
  primary: { label: 'fallback 1', rank: 'fallback_1' },
  fallback_1: { label: 'fallback 2', rank: 'fallback_2' },
  fallback_2: null,
};

/** Règle de reprise spécifique (constatée dans le code, `t1-handler`). */
const POLICIES: Record<string, string> = {
  T1: 'Échec définitif (sortie de modèle invalide sur toute la chaîne) : une seule reprise.',
};

function attemptStatusOf(h: AttemptHistoryEntry): AttemptStatus {
  switch (h.outcome) {
    case 'done': return h.businessResult === 'FAILED' ? 'FAILED' : 'SUCCESS';
    case 'failed': return 'FAILED';
    case 'interrupted': return 'INTERRUPTED';
    case 'deferred': return 'DEFERRED';
    case 'abandoned': return 'ABANDONED';
    default: return 'FAILED';
  }
}

function inWindow(c: ExecutionRow, h: AttemptHistoryEntry): boolean {
  if (!h.startedAt) return false;
  const t = c.createdAt.getTime();
  const from = new Date(h.startedAt).getTime();
  const to = h.endedAt ? new Date(h.endedAt).getTime() : Number.POSITIVE_INFINITY;
  return t >= from - 1000 && t <= to + 1000;
}

export function buildJobExecutionView(p: {
  job: {
    id: number; treatment: string; status: string; attempts: number;
    availableAt: Date | null; businessResult: string | null; lastError: string | null;
  };
  history: AttemptHistoryEntry[];
  /** Tous les appels modèle du job (toutes traces), ordre chronologique. */
  calls: ExecutionRow[];
  diagnostics: StoredCallDiagnostic[];
  maxAttempts: number | null;
  now?: number;
}): JobExecutionView {
  const now = p.now ?? Date.now();
  const { job } = p;
  // Ordre d'écriture (append à chaque clôture) = ordre chronologique.
  const history = p.history;

  // Rattachement des appels à leur tentative : `metadata.jobAttempt`, sinon
  // fenêtre temporelle de l'historique, sinon non attribués (traces anciennes).
  const parTentative = new Map<number, ExecutionRow[]>();
  const nonAttribues: ExecutionRow[] = [];
  for (const c of p.calls) {
    let n = c.jobAttempt;
    if (n == null) n = history.find((h) => inWindow(c, h))?.attempt ?? null;
    if (n == null && job.status === 'RUNNING' && history.length === 0) n = job.attempts;
    if (n == null) { nonAttribues.push(c); continue; }
    parTentative.set(n, [...(parTentative.get(n) ?? []), c]);
  }
  const rapports = (calls: ExecutionRow[]): CallReport[] =>
    calls.length ? buildExecutionDiagnosis({ treatment: job.treatment, calls, diagnostics: p.diagnostics, job: null }).calls : [];

  const attempts: JobAttemptView[] = [];
  const dernierIndex = new Map<number, number>();
  history.forEach((h, i) => dernierIndex.set(h.attempt, i));
  history.forEach((h, i) => {
    const calls = dernierIndex.get(h.attempt) === i ? rapports(parTentative.get(h.attempt) ?? []) : [];
    const analyses = calls.filter((c) => c.callKind === 'analysis');
    const lastFailed = [...analyses].reverse().find((c) => c.status === 'FAILED');
    const status = attemptStatusOf(h);
    attempts.push({
      attempt: h.attempt, status, startedAt: h.startedAt, endedAt: h.endedAt,
      calls, modelCalls: analyses.length, runningCall: null,
      cause: status === 'FAILED' || status === 'ABANDONED' ? lastFailed?.cause ?? (h.timedOut ? 'TIMEOUT' : null) : null,
      technicalError: h.error ?? null,
      retryScheduled: typeof h.retryScheduled === 'boolean' ? h.retryScheduled : null,
      nextAttemptAt: h.nextAttemptAt ?? null,
    });
  });

  // Tentative EN COURS (pas encore dans l'historique).
  const dejaClose = history.some((h) => h.attempt === job.attempts && h.outcome !== 'interrupted' && h.outcome !== 'deferred');
  if (job.status === 'RUNNING' && !dejaClose) {
    const calls = rapports(parTentative.get(job.attempts) ?? []);
    const analyses = calls.filter((c) => c.callKind === 'analysis');
    const last = analyses[analyses.length - 1];
    // Cas 1 : le dernier appel de la cascade a échoué et le job tourne
    // toujours — le rang suivant est en cours.
    const runningCall = !last ? { label: 'principal', rank: 'primary' }
      : last.status === 'FAILED' ? NEXT_RANK[last.rank ?? ''] ?? null : null;
    attempts.push({
      attempt: job.attempts, status: 'RUNNING', startedAt: null, endedAt: null,
      calls, modelCalls: analyses.length, runningCall, cause: null, technicalError: null,
      retryScheduled: null, nextAttemptAt: null,
    });
  }

  // Nouvelle tentative réellement en file (cas 2 : « Tentative job #2 : QUEUED »).
  const derniere = history[history.length - 1];
  const retryEnFile = job.status === 'PENDING' && job.attempts >= 1
    && (derniere ? derniere.retryScheduled === true || derniere.outcome === 'abandoned' : true);
  const prochaine = job.availableAt
    ? (job.availableAt.getTime() <= now ? 'IMMEDIATE' as const : job.availableAt.toISOString())
    : null;
  if (retryEnFile) {
    attempts.push({
      attempt: job.attempts + 1, status: 'QUEUED', startedAt: null, endedAt: null,
      calls: [], modelCalls: 0, runningCall: null, cause: null, technicalError: null,
      retryScheduled: null, nextAttemptAt: typeof prochaine === 'string' && prochaine !== 'IMMEDIATE' ? prochaine : null,
    });
  }

  // Retry : intervenu (ou en cours) seulement si une 2e exécution existe ou
  // est réellement en file après un échec.
  const finished = job.status === 'DONE' || job.status === 'FAILED' || job.status === 'CANCELLED';
  const automatic = retryEnFile || job.attempts >= 2;
  let state: RetryState | null = null;
  if (retryEnFile) state = 'QUEUED';
  else if (automatic && job.status === 'RUNNING') state = 'RUNNING';
  else if (automatic && finished) state = job.status === 'DONE' && job.businessResult !== 'FAILED' ? 'SUCCESS' : 'FAILED';
  const declencheur = [...attempts].reverse().find((a) => a.status === 'FAILED' || a.status === 'ABANDONED');

  return {
    jobId: job.id,
    jobStatus: job.status,
    businessResult: job.businessResult,
    attemptsCount: job.attempts,
    attempts,
    retry: {
      currentAttempt: retryEnFile ? job.attempts + 1 : Math.max(job.attempts, 1),
      maxAttempts: p.maxAttempts,
      automatic,
      state,
      scheduled: retryEnFile,
      reason: automatic ? declencheur?.cause ?? declencheur?.technicalError ?? job.lastError ?? null : null,
      nextAttempt: retryEnFile ? prochaine : null,
      policy: POLICIES[job.treatment] ?? null,
    },
    legacyCalls: rapports(nonAttribues),
  };
}
