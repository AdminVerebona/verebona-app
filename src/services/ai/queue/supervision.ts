/**
 * Supervision technique de la file IA et de T3 — lot 52A (ticket « [P1] T3 —
 * non-déclenchement des exécutions manuelles et horaires », COR-04, COR-05).
 *
 * Répond, depuis le BO et sans accès à la base, aux questions du PO :
 *   · le boucleur tourne-t-il, et sur combien d'instances ? (battements, toutes
 *     instances — jamais l'état d'un seul processus présenté comme global) ;
 *   · l'exécutant T3 est-il disponible ? sinon, POURQUOI (arrêt d'urgence,
 *     T3 désactivé / suspendu, aucun boucleur vivant, exécutant absent) ;
 *   · quel est le dernier passage T3 manuel et automatique : création, début,
 *     fin, durée, objets examinés / modifiés, résultat (NO_CHANGE compris),
 *     appels modèle (0 = passage sans Gemini), motif d'échec ou d'attente ;
 *   · quand est attendu le prochain balayage horaire.
 *
 * Les règles de lecture (phase d'un job, disponibilité) sont pures et testées.
 */
import type { QueuedJob } from './job-queue.repository';
import type { WorkerSummary } from './worker-heartbeat';

// ── Phase d'exécution d'un job (COR-05) ─────────────────────────────────────

/**
 * Phase lisible d'un job, distincte du statut technique :
 *   · CREATED_NOT_STARTED — créé, jamais démarré ;
 *   · WAITING_RETRY       — déjà tenté, en attente d'une nouvelle tentative / report ;
 *   · STARTED             — en cours d'exécution ;
 *   · DONE_NO_CHANGE      — terminé sans modification (NO_CHANGE, SUPERSEDED, ABSTAIN, TARGET_GONE) ;
 *   · DONE_CHANGED        — terminé avec modification (APPLIED) ;
 *   · DONE                — terminé sans résultat métier (T1, T4) ;
 *   · FAILED              — en échec (technique, ou résultat métier FAILED) ;
 *   · CANCELLED           — annulé.
 */
export type ExecutionPhase =
  | 'CREATED_NOT_STARTED' | 'WAITING_RETRY' | 'STARTED' | 'DONE_NO_CHANGE' | 'DONE_CHANGED' | 'DONE' | 'FAILED' | 'CANCELLED';

export function executionPhase(job: Pick<QueuedJob, 'status' | 'attempts' | 'businessResult' | 'lastError'> & { attemptHistoryLength?: number }): ExecutionPhase {
  switch (job.status) {
    case 'PENDING':
      return job.attempts > 0 || (job.attemptHistoryLength ?? 0) > 0 || job.lastError ? 'WAITING_RETRY' : 'CREATED_NOT_STARTED';
    case 'RUNNING': return 'STARTED';
    case 'CANCELLED': return 'CANCELLED';
    case 'FAILED': return 'FAILED';
    case 'DONE':
      if (job.businessResult === 'APPLIED') return 'DONE_CHANGED';
      if (job.businessResult === 'FAILED') return 'FAILED';
      if (job.businessResult) return 'DONE_NO_CHANGE';
      return 'DONE';
  }
  return 'DONE';
}

// ── Disponibilité de l'exécutant T3 ─────────────────────────────────────────

export interface ExecutorAvailability {
  available: boolean;
  /** Motif de non-démarrage, ou `null`. */
  reason: string | null;
  code: 'OK' | 'EMERGENCY_STOP' | 'DISABLED' | 'SUSPENDED' | 'NO_LIVE_WORKER' | 'NO_T3_EXECUTOR' | 'UNKNOWN_WORKERS';
}

/** Pure, testée. L'ordre suit la portée : environnement, traitement, service. */
export function t3ExecutorAvailability(input: {
  emergencyStop: boolean;
  state: 'ENABLED' | 'DISABLED' | 'SUSPENDED';
  suspendedReason?: string | null;
  nextProbeAt?: Date | null;
  workers: Pick<WorkerSummary, 'state' | 'liveInstances' | 't3ExecutorInstances'>;
}): ExecutorAvailability {
  if (input.emergencyStop) return { available: false, code: 'EMERGENCY_STOP', reason: 'Arrêt d’urgence engagé : aucun traitement ne démarre.' };
  if (input.state === 'DISABLED') return { available: false, code: 'DISABLED', reason: 'T3 est désactivé : les jobs attendent sa réactivation.' };
  if (input.state === 'SUSPENDED') {
    const sonde = input.nextProbeAt ? ` Prochaine sonde : ${input.nextProbeAt.toISOString()}.` : '';
    return { available: false, code: 'SUSPENDED', reason: `T3 est suspendu${input.suspendedReason ? ` (${input.suspendedReason})` : ''}.${sonde}` };
  }
  if (input.workers.state === 'UNKNOWN') {
    return { available: true, code: 'UNKNOWN_WORKERS', reason: 'Battements du boucleur indisponibles (migration 0338 non appliquée) : état des instances inconnu.' };
  }
  if (input.workers.liveInstances === 0) {
    return { available: false, code: 'NO_LIVE_WORKER', reason: 'Aucune instance du boucleur n’a donné signe de vie récemment : les jobs restent en file (rien n’est perdu) jusqu’au redémarrage.' };
  }
  if (input.workers.t3ExecutorInstances === 0) {
    return { available: false, code: 'NO_T3_EXECUTOR', reason: 'Aucune instance vivante n’a enregistré l’exécutant T3 : les jobs T3 ne sont pas prélevés.' };
  }
  return { available: true, code: 'OK', reason: null };
}

// ── Lecture ─────────────────────────────────────────────────────────────────

export interface T3JobSummary {
  id: number;
  accountId: number | null;
  origin: string;
  triggerCode: string | null;
  kind: string | null;
  status: string;
  phase: ExecutionPhase;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  attempts: number;
  objectsExamined: number | null;
  objectsModified: number | null;
  openActionsExamined: number | null;
  aiCalls: number | null;
  businessResult: string | null;
  /** Motif d'échec, d'attente ou d'abstention. */
  reason: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Résumé d'un job pour la supervision (pur, testé). */
export function summarizeT3Job(job: QueuedJob & { attemptHistoryLength?: number }): T3JobSummary {
  const d = (job.businessResultDetail ?? {}) as Record<string, unknown>;
  const phase = executionPhase(job);
  const debut = job.startedAt;
  const fin = job.finishedAt;
  let reason: string | null = null;
  if (phase === 'FAILED' || phase === 'WAITING_RETRY') reason = job.lastError;
  else if (job.businessResult === 'ABSTAIN') reason = 'Abstention : éléments insuffisants pour décider (À traiter créé ou maintenu).';
  else if (job.businessResult === 'SUPERSEDED') reason = typeof d.reason === 'string' ? d.reason : 'Couvert par une exécution plus récente.';
  else if (job.businessResult === 'TARGET_GONE') reason = 'Cible disparue depuis la mise en file.';
  return {
    id: job.id,
    accountId: job.accountId,
    origin: job.origin,
    triggerCode: job.triggerCode,
    kind: typeof job.payload?.kind === 'string' ? job.payload.kind : null,
    status: job.status,
    phase,
    createdAt: job.createdAt.toISOString(),
    startedAt: debut ? debut.toISOString() : null,
    finishedAt: fin ? fin.toISOString() : null,
    durationMs: debut && fin ? Math.max(0, fin.getTime() - debut.getTime()) : null,
    attempts: job.attempts,
    objectsExamined: num(d.objectsExamined),
    objectsModified: num(d.objectsModified) ?? num(d.decisionsApplied),
    openActionsExamined: num(d.openActionsExamined),
    aiCalls: num(d.aiCalls),
    businessResult: job.businessResult ?? null,
    reason,
  };
}

export interface T3Supervision {
  generatedAt: string;
  workers: WorkerSummary;
  executor: ExecutorAvailability;
  state: { treatment: 'T3'; state: 'ENABLED' | 'DISABLED' | 'SUSPENDED'; suspendedReason: string | null; nextProbeAt: string | null };
  emergencyStop: boolean;
  queue: { pending: number; pendingReady: number; running: number; failedLast24h: number; oldestReadyCreatedAt: string | null };
  schedule: { triggerCode: string | null; periodHours: number | null; lastRootCreatedAt: string | null; nextDueAt: string | null };
  /** Dernier contrôle de compte lancé à la main. */
  lastManual: T3JobSummary | null;
  /** Dernier contrôle de compte automatique (planifié ou événementiel). */
  lastAutomatic: T3JobSummary | null;
  /** Dernière racine de balayage planifié. */
  lastSweep: T3JobSummary | null;
}

export async function getT3Supervision(now: Date = new Date()): Promise<T3Supervision> {
  const [{ pgClient }, repo, hb, triggers, { SCHEDULE_PERIOD_HOURS }] = await Promise.all([
    import('@/db'), import('./job-queue.repository'), import('./worker-heartbeat'), import('./triggers'), import('../config/catalogs'),
  ]);
  const [states, stop, heartbeats] = await Promise.all([repo.getTreatmentStates(), repo.getEmergencyStop(), hb.listWorkerHeartbeats()]);
  const etat = states.find((s) => s.treatment === 'T3');
  const workers = hb.summarizeWorkers(heartbeats, now);
  const state = etat?.state ?? 'ENABLED';

  const dernier = async (where: string): Promise<T3JobSummary | null> => {
    const rows = (await pgClient.unsafe(
      `SELECT id FROM ai_job_queue WHERE treatment = 'T3' AND ${where} ORDER BY created_at DESC, id DESC LIMIT 1`,
      [] as never[],
    )) as unknown as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const [job] = await repo.listJobs({ ids: [Number(rows[0].id)] });
    return job ? summarizeT3Job(job) : null;
  };

  const [compteurs] = (await pgClient.unsafe(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
            count(*) FILTER (WHERE status = 'PENDING' AND available_at <= now())::int AS ready,
            count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
            count(*) FILTER (WHERE status = 'FAILED' AND finished_at > now() - interval '24 hours')::int AS failed,
            min(created_at) FILTER (WHERE status = 'PENDING' AND available_at <= now()) AS oldest
       FROM ai_job_queue WHERE treatment = 'T3'`,
    [] as never[],
  )) as unknown as Array<Record<string, unknown>>;

  // Planification effective (même règle que `runDueSchedules`).
  let triggerCode: string | null = null;
  try {
    const { resolveTreatmentConfig } = await import('../config/config-resolver');
    const cfg = await resolveTreatmentConfig('T3').catch(() => null);
    triggerCode = triggers.shortestSchedule(triggers.activeTriggerCodes('T3', cfg?.triggers ?? null))?.code ?? null;
  } catch { triggerCode = null; }
  const periodHours = triggerCode ? SCHEDULE_PERIOD_HOURS[triggerCode] ?? null : null;
  const [racine] = (await pgClient.unsafe(
    `SELECT max(created_at) AS at FROM ai_job_queue
      WHERE treatment = 'T3' AND account_id IS NULL AND target_type IS NULL AND trigger_code LIKE 'schedule\\_%'`,
    [] as never[],
  )) as unknown as Array<{ at: Date | string | null }>;
  const lastRoot = racine?.at ? new Date(String(racine.at)) : null;
  const nextDue = periodHours == null ? null : lastRoot ? new Date(lastRoot.getTime() + periodHours * 3_600_000) : now;

  const [lastManual, lastAutomatic, lastSweep] = await Promise.all([
    dernier(`origin = 'manual' AND account_id IS NOT NULL AND target_type IS NULL`),
    dernier(`origin = 'automatic' AND account_id IS NOT NULL AND target_type IS NULL`),
    dernier(`account_id IS NULL AND target_type IS NULL`),
  ]);

  const c = compteurs ?? {};
  return {
    generatedAt: now.toISOString(),
    workers,
    executor: t3ExecutorAvailability({
      emergencyStop: stop.active, state, suspendedReason: etat?.suspendedReason ?? null,
      nextProbeAt: etat?.nextProbeAt ?? null, workers,
    }),
    state: {
      treatment: 'T3', state, suspendedReason: etat?.suspendedReason ?? null,
      nextProbeAt: etat?.nextProbeAt ? etat.nextProbeAt.toISOString() : null,
    },
    emergencyStop: stop.active,
    queue: {
      pending: Number(c.pending ?? 0), pendingReady: Number(c.ready ?? 0), running: Number(c.running ?? 0),
      failedLast24h: Number(c.failed ?? 0), oldestReadyCreatedAt: c.oldest ? new Date(String(c.oldest)).toISOString() : null,
    },
    schedule: {
      triggerCode, periodHours,
      lastRootCreatedAt: lastRoot ? lastRoot.toISOString() : null,
      nextDueAt: nextDue ? nextDue.toISOString() : null,
    },
    lastManual, lastAutomatic, lastSweep,
  };
}
