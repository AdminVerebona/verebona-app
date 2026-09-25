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
  dedupeKey, decideQueueing, afterFailure, MAX_ATTEMPTS,
  type JobOrigin, type JobScope, type JobStatus, type QueueDecision,
} from './queue-policy';
import { abortLocalExecutions } from './execution-control';

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
  /** Jeton de l'exécution en cours (tiré à chaque prélèvement). */
  executionId: string | null;
  workerId: string | null;
  leaseExpiresAt: Date | null;
  recoveredCount: number;
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
    executionId: r.execution_id == null ? null : String(r.execution_id),
    workerId: r.worker_id == null ? null : String(r.worker_id),
    leaseExpiresAt: r.lease_expires_at ? new Date(String(r.lease_expires_at)) : null,
    recoveredCount: Number(r.recovered_count ?? 0),
  };
}

const COLS = `id, treatment, account_id, target_type, target_id, status, origin,
              trigger_code, attempts, last_error, available_at,
              coalesce_requested, head_priority, created_at, started_at, finished_at,
              payload, execution_id, worker_id, lease_expires_at, recovered_count`;

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
  // ══════════════════════════════════════════════════════════════════════
  // LE PAYLOAD FAIT PARTIE DE L'INSERTION
  //
  // L'instruction déclarait 7 colonnes / 7 paramètres alors que 8 valeurs
  // étaient transmises (la 8e : le payload). Le contexte de reprise — compte,
  // cible, origine, utilisateur à l'origine — n'était donc pas garanti en base,
  // et un job repris après redémarrage perdait son utilisateur et son origine.
  //
  // `RETURNING payload` : la mise en file n'est acquittée qu'une fois le
  // contexte relu tel qu'écrit (SCR-08).
  // ══════════════════════════════════════════════════════════════════════
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_job_queue
       (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id, payload`,
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
  if (input.payload && (row.payload == null || typeof row.payload !== 'object')) {
    throw new Error(`[queue] Job ${row.id} persisté sans son contexte de reprise : la demande n'est pas acquittée.`);
  }
  return { decision, jobId: Number(row.id) };
}

// ── Prélèvement et fin d'exécution ──────────────────────────────────────────

/** Durée du bail d'exécution, renouvelé par l'exécutant tant qu'il travaille. */
export const LEASE_SECONDS = Number(process.env.AI_QUEUE_LEASE_SECONDS ?? 300);

/**
 * Délai au-delà duquel un RUNNING SANS bail (ligne antérieure à la migration
 * 0141) est considéré abandonné.
 */
const LEGACY_STALE_SECONDS = Number(process.env.AI_QUEUE_LEGACY_STALE_SECONDS ?? 3600);

/**
 * Prélève le prochain job d'un traitement, ou `null`.
 *
 * Rend `null` — plutôt que de lever — quand le traitement est désactivé,
 * suspendu ou sous arrêt d'urgence : ce n'est pas une anomalie, c'est l'état
 * normal d'un traitement coupé, et le boucleur ne doit pas le traiter en erreur.
 *
 * Le prélèvement tire un jeton d'exécution et ouvre un bail : seule
 * l'exécution qui détient le jeton peut clore le job, et un bail non
 * renouvelé signale une exécution abandonnée (`recoverAbandonedJobs`).
 */
export async function claimNext(
  treatment: Treatment,
  workerId: string | null = null,
  leaseSeconds: number = LEASE_SECONDS,
): Promise<QueuedJob | null> {
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
            attempts = attempts + 1, head_priority = FALSE,
            execution_id = gen_random_uuid(), worker_id = $2,
            lease_expires_at = NOW() + ($3 || ' seconds')::interval,
            heartbeat_at = NOW()
      WHERE id IN (SELECT id FROM suivant)
      RETURNING ${COLS}`,
    [treatment, workerId, String(leaseSeconds)] as never[],
  );

  const r = (rows as unknown as Row[])[0];
  return r ? toJob(r) : null;
}

/**
 * Renouvelle le bail d'une exécution.
 *
 * Rend `false` si l'exécution n'est plus titulaire du job (reprise ailleurs,
 * interrompue par l'administration) : elle doit alors s'arrêter sans écrire.
 */
export async function renewLease(
  jobId: number,
  executionId: string,
  leaseSeconds: number = LEASE_SECONDS,
): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `UPDATE ai_job_queue
        SET lease_expires_at = NOW() + ($3 || ' seconds')::interval, heartbeat_at = NOW()
      WHERE id = $1 AND execution_id = $2 AND status = 'RUNNING'
      RETURNING id`,
    [jobId, executionId, String(leaseSeconds)] as never[],
  );
  return (rows as unknown as Row[]).length > 0;
}

/**
 * Reprend les exécutions abandonnées (processus arrêté brutalement).
 *
 * Seuls les RUNNING dont le bail a EXPIRÉ sont visés — un RUNNING vivant sur
 * une autre instance renouvelle son bail et n'est jamais touché. Les lignes
 * antérieures au bail (sans `lease_expires_at`) le sont après
 * `LEGACY_STALE_SECONDS`.
 *
 * Une seule instruction, `FOR UPDATE SKIP LOCKED` : plusieurs instances qui
 * démarrent ensemble ne reprennent jamais deux fois le même job.
 *
 * Tentatives : le prélèvement interrompu a consommé sa tentative (le
 * compteur n'est pas réécrit). Un job qui a épuisé ses tentatives passe en
 * FAILED au lieu de boucler sur un travail qui fait tomber le processus.
 * Payload, compte et cible sont conservés ; le jeton est révoqué.
 */
export async function recoverAbandonedJobs(): Promise<Array<{ id: number; status: JobStatus }>> {
  const rows = await pgClient.unsafe(
    `WITH abandonnes AS (
       SELECT id FROM ai_job_queue
        WHERE status = 'RUNNING'
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
            OR (lease_expires_at IS NULL AND started_at < NOW() - ($1 || ' seconds')::interval)
          )
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ai_job_queue q
        SET status = CASE WHEN q.attempts >= $2 THEN 'FAILED' ELSE 'PENDING' END,
            finished_at = CASE WHEN q.attempts >= $2 THEN NOW() ELSE NULL END,
            last_error = CASE WHEN q.attempts >= $2
              THEN 'exécution abandonnée (processus arrêté) — tentatives épuisées'
              ELSE 'exécution abandonnée (processus arrêté) — reprise automatique' END,
            execution_id = NULL, worker_id = NULL, lease_expires_at = NULL,
            started_at = NULL, head_priority = TRUE, available_at = NOW(),
            recovered_count = q.recovered_count + 1
       FROM abandonnes a
      WHERE q.id = a.id
      RETURNING q.id, q.status`,
    [String(LEGACY_STALE_SECONDS), MAX_ATTEMPTS] as never[],
  );
  return (rows as unknown as Row[]).map((r) => ({ id: Number(r.id), status: String(r.status) as JobStatus }));
}

/**
 * Clôt une exécution réussie.
 *
 * Si un passage supplémentaire a été demandé pendant l'exécution (WF-10), un
 * nouveau job est créé — et un seul, quel que soit le nombre d'événements
 * survenus entre-temps.
 */
export async function completeJob(
  jobId: number,
  executionId: string | null = null,
): Promise<{ requeued: boolean; stale?: boolean }> {
  // Seule l'exécution titulaire peut clore : une exécution reprise ailleurs
  // ou interrompue ne passe jamais le job en DONE.
  const rows = await pgClient.unsafe(
    `UPDATE ai_job_queue
        SET status = 'DONE', finished_at = NOW(), execution_id = NULL, lease_expires_at = NULL
      WHERE id = $1 AND status = 'RUNNING'
        AND ($2::uuid IS NULL OR execution_id = $2::uuid)
      RETURNING ${COLS}`,
    [jobId, executionId] as never[],
  );
  const row = (rows as unknown as Row[])[0];
  if (!row) return { requeued: false, stale: true };
  const job = toJob(row);
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
export async function failJob(
  jobId: number,
  error: string,
  executionId: string | null = null,
): Promise<{ permanent: boolean; stale?: boolean }> {
  const rows0 = await pgClient.unsafe(
    `SELECT attempts FROM ai_job_queue WHERE id = $1 LIMIT 1`,
    [jobId] as never[],
  );
  const attempts = Number((rows0 as unknown as Row[])[0]?.attempts ?? 0);
  const outcome = afterFailure(attempts);

  const upd = await pgClient.unsafe(
    `UPDATE ai_job_queue
        SET status = $2, last_error = $3,
            available_at = NOW() + ($4 || ' seconds')::interval,
            finished_at = CASE WHEN $2 = 'FAILED' THEN NOW() ELSE NULL END,
            execution_id = NULL, lease_expires_at = NULL
      WHERE id = $1 AND status = 'RUNNING'
        AND ($5::uuid IS NULL OR execution_id = $5::uuid)
      RETURNING id`,
    [jobId, outcome.status, error.slice(0, 2000), String(outcome.retryInSeconds ?? 0), executionId] as never[],
  );
  // Exécution dépossédée : l'échec ne la concerne plus, rien n'est écrit.
  if ((upd as unknown as Row[]).length === 0) return { permanent: false, stale: true };

  return { permanent: outcome.status === 'FAILED' };
}

/**
 * L'exécution `executionId` est-elle toujours titulaire du job ?
 *
 * Contrôle d'écriture : appelé par la garde d'exécution avant chaque écriture
 * significative et avant la clôture.
 */
export async function isExecutionActive(jobId: number, executionId: string): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `SELECT 1 FROM ai_job_queue
      WHERE id = $1 AND execution_id = $2::uuid AND status = 'RUNNING'
      LIMIT 1`,
    [jobId, executionId] as never[],
  );
  return (rows as unknown as Row[]).length > 0;
}

/**
 * Interrompt les exécutions en cours d'un traitement et les remet en tête
 * (SCR-08, WF-06) — désactivation, arrêt d'urgence, rollback.
 *
 * ⚠️ La remise en PENDING ne suffit pas : l'exécution continuerait en
 * mémoire et écrirait ses résultats avec l'ancienne configuration. Le jeton
 * d'exécution est donc RÉVOQUÉ (execution_id = NULL) : l'ancienne exécution
 * ne peut plus écrire (garde), ni passer le job en DONE (clôture
 * conditionnée au jeton). L'interruption est signalée tout de suite aux
 * exécutions de ce processus ; les autres instances la constatent au
 * prochain contrôle ou battement de bail.
 *
 * Les tentatives sont décrémentées : une exécution coupée par une décision
 * d'exploitation n'a pas échoué, et la compter épuiserait le quota de reprises
 * d'un job parfaitement sain.
 */
export async function requeueRunning(treatment: Treatment, reason: string): Promise<number> {
  const rows = await pgClient.unsafe(
    `UPDATE ai_job_queue
        SET status = 'PENDING', head_priority = TRUE, started_at = NULL,
            attempts = GREATEST(attempts - 1, 0), available_at = NOW(),
            last_error = $2,
            execution_id = NULL, worker_id = NULL, lease_expires_at = NULL
      WHERE treatment = $1 AND status = 'RUNNING'
      RETURNING id`,
    [treatment, `interrompu : ${reason}`] as never[],
  );
  const ids = (rows as unknown as Row[]).map((r) => Number(r.id));
  abortLocalExecutions(ids, reason);
  return ids.length;
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
