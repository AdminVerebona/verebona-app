/**
 * File durable et état opérationnel — CDC BO IA GEN-004, NFR-003, SCR-08, §4.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « ÉCHEC DE PERSISTANCE : NE PAS ACQUITTER LA MISE EN FILE »
 *
 * Le SCR-08 le pose comme règle de gestion d'erreur. `enqueue` ne rend donc
 * jamais un succès approximatif : ou la ligne est écrite, ou l'appel lève.
 * Acquitter une mise en file qui n'a pas abouti perdrait le travail sans que
 * personne ne le sache — le pire mode de défaillance pour une file.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE PRÉLÈVEMENT EST ATOMIQUE
 *
 * `claimNext` sélectionne et marque en une seule instruction, avec
 * `FOR UPDATE SKIP LOCKED`. Deux instances qui liraient puis marqueraient
 * prendraient le même job — et le §15.2 promet qu'un objet n'est traité qu'une
 * fois. `SKIP LOCKED` plutôt qu'un verrou d'attente : une instance occupée ne
 * doit pas bloquer les autres sur un job qu'elle ne prendra pas.
 */
import { pgClient } from '@/db';
import type { Treatment } from '../config/treatments';
import {
  dedupeKey, decideQueueing, afterFailure,
  type JobOrigin, type JobScope, type JobStatus, type QueueDecision,
} from './queue-policy';

type Row = Record<string, unknown>;

export interface QueuedJob {
  id: number;
  treatment: Treatment;
  accountId: number | null;
  targetType: string | null;
  targetId: string | null;
  status: JobStatus;
  origin: JobOrigin;
  triggerCode: string | null;
  attempts: number;
  lastError: string | null;
  availableAt: Date;
  coalesceRequested: boolean;
  headPriority: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Contexte de reprise : identifiants et libellés, jamais de données métier. */
  payload: Record<string, unknown> | null;
}

function toJob(r: Row): QueuedJob {
  return {
    id: Number(r.id),
    treatment: String(r.treatment) as Treatment,
    accountId: r.account_id == null ? null : Number(r.account_id),
    targetType: r.target_type == null ? null : String(r.target_type),
    targetId: r.target_id == null ? null : String(r.target_id),
    status: String(r.status) as JobStatus,
    origin: String(r.origin) as JobOrigin,
    triggerCode: r.trigger_code == null ? null : String(r.trigger_code),
    attempts: Number(r.attempts),
    lastError: r.last_error == null ? null : String(r.last_error),
    availableAt: new Date(String(r.available_at)),
    coalesceRequested: Boolean(r.coalesce_requested),
    headPriority: Boolean(r.head_priority),
    createdAt: new Date(String(r.created_at)),
    startedAt: r.started_at ? new Date(String(r.started_at)) : null,
    finishedAt: r.finished_at ? new Date(String(r.finished_at)) : null,
    payload: (r.payload ?? null) as Record<string, unknown> | null,
  };
}

const COLS = `id, treatment, account_id, target_type, target_id, status, origin,
              trigger_code, attempts, last_error, available_at,
              coalesce_requested, head_priority, created_at, started_at, finished_at,
              payload`;

// ── Mise en file ────────────────────────────────────────────────────────────

export interface EnqueueInput {
  treatment: Treatment;
  scope?: JobScope;
  origin?: JobOrigin;
  triggerCode?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface EnqueueResult {
  decision: QueueDecision;
  jobId: number | null;
}

/**
 * Met un travail en file, en appliquant la déduplication du WF-10.
 *
 * Trois issues, et c'est `queue-policy` qui les décide : créer, ne rien
 * ajouter, ou demander un passage supplémentaire consolidé sur l'exécution en
 * cours. Le lancement manuel passe toujours outre (WF-11).
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const origin = input.origin ?? 'automatic';
  const key = dedupeKey(input.treatment, input.scope ?? {});

  const existingRows = await pgClient.unsafe(
    `SELECT id, status FROM ai_job_queue
      WHERE dedupe_key = $1 AND origin = 'automatic'
        AND status IN ('PENDING', 'RUNNING')
      LIMIT 1`,
    [key] as never[],
  );
  const existing = (existingRows as unknown as Row[])[0];

  const decision = decideQueueing(
    existing ? { status: String(existing.status) as JobStatus } : null,
    origin,
  );

  if (decision === 'skip') {
    return { decision, jobId: Number(existing.id) };
  }

  if (decision === 'coalesce') {
    // Un drapeau sur l'exécution en cours, jamais une seconde ligne : dix
    // événements pendant une analyse produisent un passage, pas dix.
    await pgClient.unsafe(
      `UPDATE ai_job_queue SET coalesce_requested = TRUE WHERE id = $1`,
      [Number(existing.id)] as never[],
    );
    return { decision, jobId: Number(existing.id) };
  }

  const scope = input.scope ?? {};
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_job_queue
       (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.treatment,
      scope.accountId ?? null,
      scope.targetType ?? null,
      scope.targetId == null ? null : String(scope.targetId),
      key, origin, input.triggerCode ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
    ] as never[],
  );

  const row = (rows as unknown as Row[])[0];
  if (!row) {
    // SCR-08 : ne pas acquitter une mise en file qui n'a pas abouti.
    throw new Error('[queue] Mise en file non persistée : la demande n\'est pas acquittée.');
  }
  return { decision, jobId: Number(row.id) };
}

// ── Prélèvement et fin d'exécution ──────────────────────────────────────────

/**
 * Prélève le prochain job d'un traitement, ou `null`.
 *
 * Rend `null` — plutôt que de lever — quand le traitement est désactivé,
 * suspendu ou sous arrêt d'urgence : ce n'est pas une anomalie, c'est l'état
 * normal d'un traitement coupé, et le boucleur ne doit pas le traiter en erreur.
 */
export async function claimNext(treatment: Treatment): Promise<QueuedJob | null> {
  if (!(await canStart(treatment))) return null;

  const rows = await pgClient.unsafe(
    `WITH suivant AS (
       SELECT id FROM ai_job_queue
        WHERE treatment = $1 AND status = 'PENDING' AND available_at <= NOW()
        ORDER BY head_priority DESC, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE ai_job_queue
        SET status = 'RUNNING', started_at = NOW(),
            attempts = attempts + 1, head_priority = FALSE
      WHERE id IN (SELECT id FROM suivant)
      RETURNING ${COLS}`,
    [treatment] as never[],
  );

  const r = (rows as unknown as Row[])[0];
  return r ? toJob(r) : null;
}

/**
 * Clôt une exécution réussie.
 *
 * Si un passage supplémentaire a été demandé pendant l'exécution (WF-10), un
 * nouveau job est créé — et un seul, quel que soit le nombre d'événements
 * survenus entre-temps.
 */
export async function completeJob(jobId: number): Promise<{ requeued: boolean }> {
  const rows = await pgClient.unsafe(
    `UPDATE ai_job_queue
        SET status = 'DONE', finished_at = NOW()
      WHERE id = $1
      RETURNING ${COLS}`,
    [jobId] as never[],
  );
  const job = toJob((rows as unknown as Row[])[0]);
  if (!job.coalesceRequested) return { requeued: false };

  await enqueue({
    treatment: job.treatment,
    scope: { accountId: job.accountId, targetType: job.targetType, targetId: job.targetId },
    origin: 'automatic',
    triggerCode: 'coalesced',
    // Le passage consolidé reprend le contexte du travail d'origine : sans lui,
    // il s'exécuterait sans utilisateur ni origine connus.
    payload: job.payload,
  });
  return { requeued: true };
}

/** Échec d'une tentative : retour en file avec temporisation, ou échec définitif. */
export async function failJob(jobId: number, error: string): Promise<{ permanent: boolean }> {
  const rows0 = await pgClient.unsafe(
    `SELECT attempts FROM ai_job_queue WHERE id = $1 LIMIT 1`,
    [jobId] as never[],
  );
  const attempts = Number((rows0 as unknown as Row[])[0]?.attempts ?? 0);
  const outcome = afterFailure(attempts);

  await pgClient.unsafe(
    `UPDATE ai_job_queue
        SET status = $2, last_error = $3,
            available_at = NOW() + ($4 || ' seconds')::interval,
            finished_at = CASE WHEN $2 = 'FAILED' THEN NOW() ELSE NULL END
      WHERE id = $1`,
    [jobId, outcome.status, error.slice(0, 2000), String(outcome.retryInSeconds ?? 0)] as never[],
  );

  return { permanent: outcome.status === 'FAILED' };
}

/**
 * Remet en tête les exécutions interrompues d'un traitement (SCR-08, WF-06).
 *
 * Appelée lors d'une désactivation, d'un arrêt d'urgence ou d'un rollback. Les
 * tentatives sont décrémentées : une exécution coupée par une décision
 * d'exploitation n'a pas échoué, et la compter épuiserait le quota de reprises
 * d'un job parfaitement sain.
 */
export async function requeueRunning(treatment: Treatment, reason: string): Promise<number> {
  const rows = await pgClient.unsafe(
    `UPDATE ai_job_queue
        SET status = 'PENDING', head_priority = TRUE, started_at = NULL,
            attempts = GREATEST(attempts - 1, 0), available_at = NOW(),
            last_error = $2
      WHERE treatment = $1 AND status = 'RUNNING'
      RETURNING id`,
    [treatment, `interrompu : ${reason}`] as never[],
  );
  return (rows as unknown as Row[]).length;
}

/**
 * Annule un job en attente (SCR-08).
 *
 * Refuse un job démarré. Le SCR-08 l'exige : « ne pas simuler une annulation
 * silencieuse » — laisser croire qu'une exécution en cours s'arrête alors
 * qu'elle continue serait pire que le refus.
 */
export async function cancelJob(jobId: number, userId: number): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `UPDATE ai_job_queue
        SET status = 'CANCELLED', finished_at = NOW(), cancelled_by = $2
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id`,
    [jobId, userId] as never[],
  );
  return (rows as unknown as Row[]).length > 0;
}

// ── Supervision ─────────────────────────────────────────────────────────────

export interface QueueSummary {
  treatment: Treatment;
  pending: number;
  running: number;
  failed: number;
}

export async function getQueueSummary(): Promise<QueueSummary[]> {
  const rows = await pgClient.unsafe(
    `SELECT treatment,
            COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'RUNNING')::int AS running,
            COUNT(*) FILTER (WHERE status = 'FAILED')::int  AS failed
       FROM ai_job_queue
      GROUP BY treatment
      ORDER BY treatment`,
    [] as never[],
  );
  return (rows as unknown as Row[]).map((r) => ({
    treatment: String(r.treatment) as Treatment,
    pending: Number(r.pending),
    running: Number(r.running),
    failed: Number(r.failed),
  }));
}

export interface QueueFilters {
  treatment?: Treatment;
  status?: JobStatus;
  accountId?: number;
  limit?: number;
}

/** NFR-001 et NFR-002 : filtré et borné côté serveur, jamais tout chargé. */
export async function listJobs(filters: QueueFilters = {}): Promise<QueuedJob[]> {
  const rows = await pgClient.unsafe(
    `SELECT ${COLS} FROM ai_job_queue
      WHERE ($1::text IS NULL OR treatment = $1)
        AND ($2::text IS NULL OR status = $2)
        AND ($3::int  IS NULL OR account_id = $3)
      ORDER BY head_priority DESC, created_at
      LIMIT $4`,
    [
      filters.treatment ?? null, filters.status ?? null,
      filters.accountId ?? null, Math.min(filters.limit ?? 100, 500),
    ] as never[],
  );
  return (rows as unknown as Row[]).map(toJob);
}

// ── État opérationnel ───────────────────────────────────────────────────────

export type TreatmentState = 'ENABLED' | 'DISABLED' | 'SUSPENDED';

/**
 * Un traitement peut-il démarrer une nouvelle exécution ?
 *
 * L'arrêt d'urgence prime sur tout (§4.3) mais n'écrase aucun état local : au
 * relâchement, chaque traitement retrouve celui qu'il avait. C'est pourquoi il
 * est lu séparément, et non appliqué en passant tous les traitements à
 * « suspendu ».
 */
export async function canStart(treatment: Treatment): Promise<boolean> {
  const stopRows = await pgClient.unsafe(
    `SELECT active FROM ai_emergency_stop WHERE id = TRUE LIMIT 1`, [] as never[],
  );
  if (Boolean((stopRows as unknown as Row[])[0]?.active)) return false;

  const rows = await pgClient.unsafe(
    `SELECT state FROM ai_treatment_state WHERE treatment = $1 LIMIT 1`,
    [treatment] as never[],
  );
  const state = (rows as unknown as Row[])[0]?.state as TreatmentState | undefined;
  // Absence de ligne = jamais configuré = activé. Un traitement neuf ne doit
  // pas rester muet faute d'une ligne que personne n'a pensé à créer.
  return state === undefined || state === 'ENABLED';
}

export async function setTreatmentState(
  treatment: Treatment,
  state: TreatmentState,
  userId: number,
  reason?: string,
): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO ai_treatment_state (treatment, state, suspended_reason, suspended_at, updated_by, updated_at)
     VALUES ($1, $2, $3, CASE WHEN $2 = 'ENABLED' THEN NULL ELSE NOW() END, $4, NOW())
     ON CONFLICT (treatment) DO UPDATE SET
       state = EXCLUDED.state,
       suspended_reason = EXCLUDED.suspended_reason,
       suspended_at = EXCLUDED.suspended_at,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [treatment, state, reason ?? null, userId] as never[],
  );

  // §4.2 : « les nouveaux jobs batch restent en file ; aucune nouvelle
  // exécution ne démarre ». Les exécutions en cours, elles, sont remises en
  // tête pour reprendre depuis le début à la réactivation.
  if (state !== 'ENABLED') {
    await requeueRunning(treatment, reason ?? `traitement ${state.toLowerCase()}`);
  }
}

export async function getTreatmentStates(): Promise<Array<{
  treatment: Treatment; state: TreatmentState;
  suspendedReason: string | null; suspendedAt: Date | null; nextProbeAt: Date | null;
}>> {
  const rows = await pgClient.unsafe(
    `SELECT treatment, state, suspended_reason, suspended_at, next_probe_at
       FROM ai_treatment_state ORDER BY treatment`,
    [] as never[],
  );
  return (rows as unknown as Row[]).map((r) => ({
    treatment: String(r.treatment) as Treatment,
    state: String(r.state) as TreatmentState,
    suspendedReason: r.suspended_reason == null ? null : String(r.suspended_reason),
    suspendedAt: r.suspended_at ? new Date(String(r.suspended_at)) : null,
    nextProbeAt: r.next_probe_at ? new Date(String(r.next_probe_at)) : null,
  }));
}

// ── Arrêt d'urgence ─────────────────────────────────────────────────────────

export async function setEmergencyStop(
  active: boolean, userId: number, reason?: string,
): Promise<void> {
  await pgClient.unsafe(
    `UPDATE ai_emergency_stop
        SET active = $1,
            reason = CASE WHEN $1 THEN $3 ELSE NULL END,
            engaged_by = CASE WHEN $1 THEN $2 ELSE engaged_by END,
            engaged_at = CASE WHEN $1 THEN NOW() ELSE engaged_at END,
            released_by = CASE WHEN $1 THEN NULL ELSE $2 END,
            released_at = CASE WHEN $1 THEN NULL ELSE NOW() END
      WHERE id = TRUE`,
    [active, userId, reason ?? null] as never[],
  );

  if (active) {
    // Les exécutions en cours reviennent en tête : elles reprendront depuis le
    // début au relâchement, avec la configuration alors effective.
    for (const t of ['T1', 'T3', 'T4'] as const) {
      await requeueRunning(t, reason ?? 'arrêt d\'urgence');
    }
  }
}

export async function getEmergencyStop(): Promise<{
  active: boolean; reason: string | null; engagedAt: Date | null;
}> {
  const rows = await pgClient.unsafe(
    `SELECT active, reason, engaged_at FROM ai_emergency_stop WHERE id = TRUE LIMIT 1`,
    [] as never[],
  );
  const r = (rows as unknown as Row[])[0];
  return {
    active: Boolean(r?.active),
    reason: r?.reason == null ? null : String(r.reason),
    engagedAt: r?.engaged_at ? new Date(String(r.engaged_at)) : null,
  };
}
