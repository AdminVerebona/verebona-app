/**
 * T6 EVALUATE — état RÉEL et DURABLE des évaluations (lot 78C, migration 0616).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « PENDING NE PEUT PLUS MASQUER UNE EXÉCUTION INEXISTANTE »
 *
 * Chaîne observable, une ligne par échéance (`t6_evaluation_runs`) :
 *
 *   échéance candidate → DEMANDÉE (PENDING, `requestT6Runs`)
 *     → PRISE (RUNNING, bail, `claimT6Runs`) → exécution → validation
 *     → persistance → COMPLETED (décision enregistrée)
 *                   | RETRY_WAIT (échec : nouvel essai planifié)
 *                   | FAILED (tentatives épuisées : reprise explicite)
 *                   | UNAVAILABLE (plafond IA du compte : essai planifié)
 *
 *   · un bail expiré (RUNNING) = traitement INTERROMPU (redémarrage,
 *     instance arrêtée) : la ligne redevient prenable, l'interruption est
 *     comptée et tracée (`interrupted`) ;
 *   · la prise est sérialisée par compte (`pg_advisory_xact_lock`, espace
 *     78016) et contrôlée ligne à ligne : jamais deux exécutions d'une même
 *     évaluation entre instances ; la clôture est conditionnée par `run_id`
 *     (une instance dépossédée n'écrit plus) ;
 *   · un contexte ou une configuration modifiés (empreinte `v4:`, signature
 *     `e2:`) relancent la demande à zéro (évaluation devenue obsolète) ;
 *   · une décision COMPLETED encore réclamée par la décision serveur à
 *     contexte inchangé est réévaluée au plus `T6_RUN_SAME_CONTEXT_MAX` fois
 *     par fenêtre de `T6_RUN_COMPLETED_COOLDOWN_MS` : aucune boucle d'appels
 *     si une décision enregistrée restait inutilisable.
 *
 * Les états techniques sont regroupés pour l'affichage
 * (`displayEvaluationState`) mais restent traçables individuellement
 * (rapports, supervision, diagnostic technique).
 *
 * Table absente (fenêtre de déploiement) : `t6RunsReady()` est faux et
 * l'appelant garde le comportement du lot 77 (mémoire de l'instance).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { envNumber } from '@/lib/env-number';

type Row = Record<string, unknown>;
type Q = (sql: string, params: unknown[]) => Promise<Row[]>;
const q: Q = async (sql, params) => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

export const T6_RUN_STATUSES = ['PENDING', 'RUNNING', 'RETRY_WAIT', 'FAILED', 'COMPLETED', 'UNAVAILABLE'] as const;
export type T6RunStatus = (typeof T6_RUN_STATUSES)[number];

/**
 * Cause d'un échec, telle que distinguée par le diagnostic (§4) :
 * indisponibilité du modèle, sortie invalide (ou décision rejetée), échec
 * d'écriture, traitement interrompu, plafond IA, tâche planifiée inactive
 * (constatée par la supervision seulement).
 */
export type T6RunErrorKind =
  | 'model_unavailable' | 'invalid_output' | 'rejected' | 'write_failed' | 'interrupted' | 'cost_cap' | 'scheduler_inactive';

/** Espace des verrous consultatifs de prise en charge (par compte). */
export const T6_RUN_LOCK_SPACE = 78016;
/** Bail d'une exécution : au-delà, elle est réputée interrompue. */
export const T6_RUN_LEASE_MS = 5 * 60_000;
/**
 * Anti-boucle : une décision enregistrée de nouveau réclamée SANS changement
 * de contexte ni de configuration (vieillissement, date de réexamen, report
 * arrivé à sa date…) est réévaluée au plus `T6_RUN_SAME_CONTEXT_MAX` fois
 * dans cette fenêtre, puis seulement après elle. Un changement de contexte
 * ou de configuration relance toujours aussitôt (empreinte, signature).
 */
export const T6_RUN_COMPLETED_COOLDOWN_MS = 20 * 3600_000;
export const T6_RUN_SAME_CONTEXT_MAX = 3;
/** Délais avant le nouvel essai, selon le nombre de tentatives déjà faites. */
export const T6_RUN_RETRY_DELAYS_S: readonly number[] = [10 * 60, 30 * 60, 2 * 3600, 6 * 3600];
/** Plafond IA du compte atteint : nouvel essai planifié (le plafond est mensuel). */
export const T6_RUN_COST_CAP_RETRY_S = 6 * 3600;

/** Tentatives au plus avant FAILED (`MASCOT_T6_EVAL_MAX_ATTEMPTS`, défaut 3, 1 à 10). */
export function t6RunMaxAttempts(env: Record<string, string | undefined> = process.env): number {
  return Math.min(10, Math.floor(envNumber('MASCOT_T6_EVAL_MAX_ATTEMPTS', 3, { min: 1 }, env)));
}

/**
 * Attente au-delà de laquelle une évaluation non aboutie est une ANOMALIE de
 * supervision et n'est plus présentée comme « en cours d'examen »
 * (`MASCOT_T6_PENDING_ALERT_MINUTES`, défaut 30, 5 à 1 440).
 */
export function t6PendingAlertMinutes(env: Record<string, string | undefined> = process.env): number {
  return Math.min(1440, Math.floor(envNumber('MASCOT_T6_PENDING_ALERT_MINUTES', 30, { min: 5 }, env)));
}

/** Délai (s) avant le nouvel essai après `attempts` tentatives (pure). */
export function t6RetryDelaySeconds(attempts: number): number {
  const i = Math.max(0, Math.min(T6_RUN_RETRY_DELAYS_S.length - 1, attempts - 1));
  return T6_RUN_RETRY_DELAYS_S[i];
}

export interface T6RunRow {
  agendaItemId: number;
  accountId: number;
  status: T6RunStatus;
  fingerprint: string | null;
  signature: string | null;
  attempts: number;
  runId: string | null;
  mode: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseUntil: string | null;
  nextAttemptAt: string | null;
  lastErrorKind: string | null;
  lastError: string | null;
  lastOutcome: string | null;
  traceId: string | null;
  interruptedCount: number;
  /** Réévaluations d'un contexte inchangé dans la fenêtre anti-boucle. */
  sameContextRuns: number;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v instanceof Date ? v.toISOString() : v)).toISOString());

function toRun(r: Row): T6RunRow {
  return {
    agendaItemId: Number(r.agenda_item_id), accountId: Number(r.account_id),
    status: String(r.status) as T6RunStatus,
    fingerprint: (r.context_fingerprint as string | null) ?? null, signature: (r.evaluation_signature as string | null) ?? null,
    attempts: Number(r.attempts ?? 0), runId: (r.run_id as string | null) ?? null, mode: (r.mode as string | null) ?? null,
    requestedAt: iso(r.requested_at) ?? new Date(0).toISOString(), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
    leaseUntil: iso(r.lease_until), nextAttemptAt: iso(r.next_attempt_at),
    lastErrorKind: (r.last_error_kind as string | null) ?? null, lastError: (r.last_error as string | null) ?? null,
    lastOutcome: (r.last_outcome as string | null) ?? null, traceId: (r.trace_id as string | null) ?? null,
    interruptedCount: Number(r.interrupted_count ?? 0), sameContextRuns: Number(r.same_context_runs ?? 0),
  };
}

// ── État effectif (pur) ──────────────────────────────────────────────────────

export interface T6EffectiveRunState {
  /** État réel : un RUNNING au bail expiré est rendu PENDING (interrompu, prenable). */
  state: T6RunStatus;
  /** Une exécution peut la prendre maintenant. */
  claimable: boolean;
  /** Instant attendu du prochain changement (fin de bail, prochain essai, fin de délai anti-boucle). */
  waitingUntil: string | null;
  /** Exécution interrompue (bail expiré). */
  interrupted: boolean;
  /** Attente anormalement longue (au-delà de `t6PendingAlertMinutes`) : anomalie, jamais « en cours ». */
  stale: boolean;
  /** Depuis quand l'évaluation attend (demande, fin du bail, essai dû). */
  since: string | null;
  attempts: number;
  lastErrorKind: string | null;
  nextAttemptAt: string | null;
}

/**
 * État effectif d'une évaluation (pure, testée). `run` absent : jamais
 * demandée (rien ne la prend encore) — PENDING prenable, sans ancienneté connue.
 */
export function effectiveRunState(run: T6RunRow | null, now: Date, opts: { alertMinutes?: number } = {}): T6EffectiveRunState {
  const alertMs = (opts.alertMinutes ?? t6PendingAlertMinutes()) * 60_000;
  const t = now.getTime();
  const ms = (s: string | null) => (s ? new Date(s).getTime() : NaN);
  const base = { attempts: run?.attempts ?? 0, lastErrorKind: run?.lastErrorKind ?? null, nextAttemptAt: run?.nextAttemptAt ?? null };
  const stale = (since: string | null) => !!since && t - ms(since) > alertMs;
  if (!run) return { ...base, state: 'PENDING', claimable: true, waitingUntil: null, interrupted: false, stale: false, since: null };
  switch (run.status) {
    case 'RUNNING': {
      if (ms(run.leaseUntil) > t) {
        return { ...base, state: 'RUNNING', claimable: false, waitingUntil: run.leaseUntil, interrupted: false, stale: stale(run.startedAt), since: run.startedAt };
      }
      // Bail expiré : exécution interrompue, reprise au prochain passage.
      return { ...base, state: 'PENDING', claimable: true, waitingUntil: null, interrupted: true, stale: stale(run.leaseUntil), since: run.leaseUntil, lastErrorKind: 'interrupted' };
    }
    case 'RETRY_WAIT':
    case 'UNAVAILABLE': {
      const du = ms(run.nextAttemptAt);
      if (Number.isFinite(du) && du > t) return { ...base, state: run.status, claimable: false, waitingUntil: run.nextAttemptAt, interrupted: false, stale: false, since: run.finishedAt };
      // Essai dû : prenable ; il ne doit pas rester dû indéfiniment (tâche inactive).
      return { ...base, state: run.status, claimable: true, waitingUntil: null, interrupted: false, stale: stale(run.nextAttemptAt ?? run.finishedAt), since: run.nextAttemptAt ?? run.finishedAt };
    }
    case 'FAILED':
      return { ...base, state: 'FAILED', claimable: false, waitingUntil: null, interrupted: false, stale: true, since: run.finishedAt };
    case 'COMPLETED': {
      // Décision enregistrée de nouveau réclamée : réévaluée dans la limite anti-boucle.
      const fin = ms(run.finishedAt);
      const libre = !Number.isFinite(fin) || t - fin >= T6_RUN_COMPLETED_COOLDOWN_MS || run.sameContextRuns < T6_RUN_SAME_CONTEXT_MAX;
      // Décision enregistrée mais encore réclamée pendant le délai : anomalie
      // (jamais présentée comme un examen en cours au-delà du délai d'alerte).
      return {
        ...base, state: 'COMPLETED', claimable: libre, waitingUntil: libre ? null : new Date(fin + T6_RUN_COMPLETED_COOLDOWN_MS).toISOString(),
        interrupted: false, stale: !libre && stale(run.finishedAt), since: run.finishedAt,
      };
    }
    default:
      return { ...base, state: 'PENDING', claimable: true, waitingUntil: null, interrupted: false, stale: stale(run.requestedAt), since: run.requestedAt };
  }
}

/** Regroupement pour l'affichage (pur) : `PENDING` (examen réellement en cours) ou `UNAVAILABLE`. */
export function displayGroupOf(s: T6EffectiveRunState): 'PENDING' | 'UNAVAILABLE' {
  if (s.stale) return 'UNAVAILABLE';
  if (s.state === 'FAILED' || s.state === 'RETRY_WAIT' || s.state === 'UNAVAILABLE') return 'UNAVAILABLE';
  return 'PENDING';
}

/** Compteurs par état réel (reporting). */
export function runStateCounters(states: Iterable<T6EffectiveRunState>): Record<T6RunStatus, number> & { stale: number; interrupted: number } {
  const c = { PENDING: 0, RUNNING: 0, RETRY_WAIT: 0, FAILED: 0, COMPLETED: 0, UNAVAILABLE: 0, stale: 0, interrupted: 0 };
  for (const s of states) {
    c[s.state] += 1;
    if (s.stale) c.stale += 1;
    if (s.interrupted) c.interrupted += 1;
  }
  return c;
}

// ── Base ─────────────────────────────────────────────────────────────────────

let ready: { ok: boolean; at: number } | null = null;

/** La table 0616 existe-t-elle ? Mémorisé (présente : définitivement ; absente : 60 s). Ne lève jamais. */
export async function t6RunsReady(): Promise<boolean> {
  if (ready && (ready.ok || Date.now() - ready.at < 60_000)) return ready.ok;
  try {
    const [r] = await q(`SELECT to_regclass('t6_evaluation_runs') IS NOT NULL AS ok`, []);
    ready = { ok: r?.ok === true, at: Date.now() };
  } catch {
    ready = { ok: false, at: Date.now() };
  }
  return ready.ok;
}
/** Réservé aux tests. */
export function resetT6RunsProbe(): void { ready = null; }

const COLS = `agenda_item_id, account_id, status, context_fingerprint, evaluation_signature, attempts, run_id, mode,
  requested_at, started_at, finished_at, lease_until, next_attempt_at, last_error_kind, last_error, last_outcome, trace_id, interrupted_count,
  same_context_runs`;

/** États des évaluations des échéances DU compte. Lève en cas d'échec. */
export async function loadT6Runs(accountId: number, ids: readonly number[]): Promise<Map<number, T6RunRow>> {
  const out = new Map<number, T6RunRow>();
  if (ids.length === 0) return out;
  const r = await q(`SELECT ${COLS} FROM t6_evaluation_runs WHERE account_id = $1 AND agenda_item_id = ANY($2::int[])`, [accountId, [...ids]]);
  for (const x of r) out.set(Number(x.agenda_item_id), toRun(x));
  return out;
}

export interface T6RunSubject { agendaItemId: number; fingerprint: string | null; signature: string | null }

const MEME_CONTEXTE = `t6_evaluation_runs.account_id = EXCLUDED.account_id
         AND t6_evaluation_runs.context_fingerprint IS NOT DISTINCT FROM EXCLUDED.context_fingerprint
         AND t6_evaluation_runs.evaluation_signature IS NOT DISTINCT FROM EXCLUDED.evaluation_signature`;
const UPSERT_DEMANDE = (cooldownS: number) => `
  INSERT INTO t6_evaluation_runs (agenda_item_id, account_id, status, context_fingerprint, evaluation_signature, requested_at)
  SELECT i.id, $1, 'PENDING', m.fp, m.sig, now()
    FROM unnest($2::int[], $3::text[], $4::text[]) AS m(id, fp, sig)
    JOIN agenda_items i ON i.id = m.id AND i.account_id = $1
  ON CONFLICT (agenda_item_id) DO UPDATE SET
    account_id = EXCLUDED.account_id, status = 'PENDING', attempts = 0, requested_at = now(),
    context_fingerprint = EXCLUDED.context_fingerprint, evaluation_signature = EXCLUDED.evaluation_signature,
    next_attempt_at = NULL, run_id = NULL, lease_until = NULL, updated_at = now(),
    same_context_runs = CASE WHEN ${MEME_CONTEXTE}
                              AND coalesce(t6_evaluation_runs.finished_at, '-infinity'::timestamptz) >= now() - make_interval(secs => ${cooldownS})
                             THEN t6_evaluation_runs.same_context_runs + 1 ELSE 0 END
  WHERE NOT (t6_evaluation_runs.status = 'RUNNING' AND t6_evaluation_runs.lease_until > now())
    AND (NOT (${MEME_CONTEXTE})
         OR (t6_evaluation_runs.status = 'COMPLETED'
             AND (coalesce(t6_evaluation_runs.finished_at, '-infinity'::timestamptz) < now() - make_interval(secs => ${cooldownS})
                  OR t6_evaluation_runs.same_context_runs < ${T6_RUN_SAME_CONTEXT_MAX})))`;

/**
 * Étape « évaluation demandée » : les échéances éligibles sans décision
 * valide sont enregistrées PENDING (idempotent). Une demande existante n'est
 * remise à zéro que si son contexte ou sa configuration ont changé (évaluation
 * obsolète), ou si une décision enregistrée est de nouveau réclamée dans la
 * limite anti-boucle — jamais pendant une exécution en cours. Bornée au compte.
 */
export async function requestT6Runs(accountId: number, subjects: readonly T6RunSubject[]): Promise<number> {
  if (subjects.length === 0) return 0;
  const r = await q(`${UPSERT_DEMANDE(T6_RUN_COMPLETED_COOLDOWN_MS / 1000)} RETURNING agenda_item_id`, [
    accountId, subjects.map((s) => s.agendaItemId), subjects.map((s) => s.fingerprint), subjects.map((s) => s.signature),
  ]);
  return r.length;
}

export type T6ClaimResult =
  | { ok: true; runId: string; attempts: Map<number, number>; interrupted: number[] }
  | { ok: false; reason: 'running_elsewhere' | 'retry_wait' | 'failed' | 'cooldown'; waitingUntil: string | null; agendaItemId: number };

interface Tx { unsafe: (s: string, p: never[]) => Promise<unknown> }

/**
 * PRISE EN CHARGE d'un lot d'évaluations (tout ou rien) : sous verrou
 * consultatif du compte, chaque ligne est créée si besoin, relue verrouillée
 * et contrôlée — une seule ligne non prenable (exécution vivante ailleurs,
 * essai planifié plus tard, échec définitif, délai anti-boucle) et rien
 * n'est pris. Sinon toutes passent RUNNING (tentative +1, bail), un bail
 * expiré étant compté comme une interruption. Lève si la base échoue.
 */
export async function claimT6Runs(p: {
  accountId: number; runId: string; mode: string; subjects: readonly T6RunSubject[]; leaseMs?: number;
}): Promise<T6ClaimResult> {
  const lease = Math.max(1, Math.floor((p.leaseMs ?? T6_RUN_LEASE_MS) / 1000));
  return (pgClient as unknown as { begin: <T>(f: (tx: Tx) => Promise<T>) => Promise<T> }).begin(async (tx) => {
    const tq: Q = async (s, params) => (await tx.unsafe(s, params as never[])) as unknown as Row[];
    await tq(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [T6_RUN_LOCK_SPACE, p.accountId]);
    await tq(UPSERT_DEMANDE(T6_RUN_COMPLETED_COOLDOWN_MS / 1000), [
      p.accountId, p.subjects.map((s) => s.agendaItemId), p.subjects.map((s) => s.fingerprint), p.subjects.map((s) => s.signature),
    ]);
    const [{ now }] = await tq(`SELECT now() AS now`, []) as Array<{ now: unknown }>;
    const lignes = await tq(
      `SELECT ${COLS} FROM t6_evaluation_runs WHERE account_id = $1 AND agenda_item_id = ANY($2::int[]) ORDER BY agenda_item_id FOR UPDATE`,
      [p.accountId, p.subjects.map((s) => s.agendaItemId)],
    );
    const maintenant = new Date(String(now instanceof Date ? now.toISOString() : now));
    for (const l of lignes.map(toRun)) {
      const e = effectiveRunState(l, maintenant, { alertMinutes: 1e6 });
      if (e.claimable) continue;
      const reason = e.state === 'RUNNING' ? 'running_elsewhere' : e.state === 'FAILED' ? 'failed' : e.state === 'COMPLETED' ? 'cooldown' : 'retry_wait';
      return { ok: false as const, reason, waitingUntil: e.waitingUntil, agendaItemId: l.agendaItemId };
    }
    const pris = await tq(
      `UPDATE t6_evaluation_runs SET
         interrupted_count = interrupted_count + CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END,
         last_error_kind = CASE WHEN status = 'RUNNING' THEN 'interrupted' ELSE last_error_kind END,
         last_error = CASE WHEN status = 'RUNNING' THEN 'exécution interrompue (bail expiré) : reprise' ELSE last_error END,
         attempts = attempts + 1,
         status = 'RUNNING', run_id = $3, mode = $4, started_at = now(), finished_at = NULL,
         lease_until = now() + make_interval(secs => $5::int), next_attempt_at = NULL, updated_at = now()
       WHERE account_id = $1 AND agenda_item_id = ANY($2::int[])
       RETURNING agenda_item_id, attempts, last_error_kind`,
      [p.accountId, p.subjects.map((s) => s.agendaItemId), p.runId, p.mode.slice(0, 20), lease],
    );
    return {
      ok: true as const, runId: p.runId,
      attempts: new Map(pris.map((x) => [Number(x.agenda_item_id), Number(x.attempts)])),
      interrupted: pris.filter((x) => x.last_error_kind === 'interrupted').map((x) => Number(x.agenda_item_id)),
    };
  });
}

export type T6RunOutcome = 'COMPLETED' | 'RETRY' | 'UNAVAILABLE';

export interface T6RunResult {
  agendaItemId: number;
  outcome: T6RunOutcome;
  errorKind?: T6RunErrorKind | null;
  error?: string | null;
  /** Issue lisible (décision acceptée et enregistrée, motif de rejet…), sans donnée personnelle. */
  detail?: string | null;
}

export interface T6FinishedRun { agendaItemId: number; status: T6RunStatus; attempts: number; nextAttemptAt: string | null; errorKind: string | null }

/**
 * CLÔTURE d'une exécution : chaque ligne encore détenue par `runId` reçoit
 * son état terminal ou sa reprise planifiée — COMPLETED, RETRY_WAIT (essai
 * planifié selon les tentatives) ou FAILED (tentatives épuisées),
 * UNAVAILABLE (plafond IA). Une ligne reprise entre-temps par une autre
 * exécution (bail expiré) n'est pas touchée. Rend les lignes écrites.
 */
export async function finishT6Runs(p: {
  accountId: number; runId: string; results: readonly T6RunResult[]; traceId?: string | null; maxAttempts?: number;
}): Promise<T6FinishedRun[]> {
  if (p.results.length === 0) return [];
  const max = p.maxAttempts ?? t6RunMaxAttempts();
  const r = await q(
    `UPDATE t6_evaluation_runs r SET
       status = CASE WHEN m.outcome = 'COMPLETED' THEN 'COMPLETED'
                     WHEN m.outcome = 'UNAVAILABLE' THEN 'UNAVAILABLE'
                     WHEN r.attempts >= $4::int THEN 'FAILED' ELSE 'RETRY_WAIT' END,
       next_attempt_at = CASE WHEN m.outcome = 'COMPLETED' THEN NULL
                              WHEN m.outcome = 'UNAVAILABLE' THEN now() + make_interval(secs => $5::int)
                              WHEN r.attempts >= $4::int THEN NULL
                              ELSE now() + make_interval(secs => ($6::int[])[least(greatest(r.attempts, 1), array_length($6::int[], 1))]) END,
       last_error_kind = CASE WHEN m.outcome = 'COMPLETED' THEN NULL ELSE m.kind END,
       last_error = CASE WHEN m.outcome = 'COMPLETED' THEN NULL ELSE left(m.err, 500) END,
       last_outcome = left(m.detail, 300), trace_id = coalesce($7, r.trace_id),
       finished_at = now(), lease_until = NULL, updated_at = now()
     FROM unnest($3::int[], $8::text[], $9::text[], $10::text[], $11::text[]) AS m(id, outcome, kind, err, detail)
     WHERE r.account_id = $1 AND r.run_id = $2 AND r.status = 'RUNNING' AND r.agenda_item_id = m.id
     RETURNING r.agenda_item_id, r.status, r.attempts, r.next_attempt_at, r.last_error_kind`,
    [p.accountId, p.runId, p.results.map((x) => x.agendaItemId), max, T6_RUN_COST_CAP_RETRY_S, [...T6_RUN_RETRY_DELAYS_S], p.traceId ?? null,
      p.results.map((x) => x.outcome), p.results.map((x) => x.errorKind ?? null), p.results.map((x) => x.error ?? null), p.results.map((x) => x.detail ?? null)],
  );
  return r.map((x) => ({
    agendaItemId: Number(x.agenda_item_id), status: String(x.status) as T6RunStatus, attempts: Number(x.attempts),
    nextAttemptAt: iso(x.next_attempt_at), errorKind: (x.last_error_kind as string | null) ?? null,
  }));
}

/**
 * Reprise EXPLICITE (BO › Supervision) : les évaluations en échec, en
 * attente d'essai ou indisponibles du compte repartent à zéro (PENDING) et
 * une pré-génération durable est demandée. Rend le nombre d'évaluations relancées.
 */
export async function resetT6RunsForRetry(accountId: number): Promise<number> {
  const r = await q(
    `UPDATE t6_evaluation_runs SET status = 'PENDING', attempts = 0, next_attempt_at = NULL, requested_at = now(),
            run_id = NULL, lease_until = NULL, last_outcome = 'reprise explicite (BO)', updated_at = now()
      WHERE account_id = $1 AND status IN ('FAILED', 'RETRY_WAIT', 'UNAVAILABLE')
     RETURNING agenda_item_id`,
    [accountId],
  );
  if (r.length > 0) await (await import('./pregen-queue')).requestMascotPregeneration(accountId, 't6-retry-bo');
  return r.length;
}

// ── Supervision (§4) ─────────────────────────────────────────────────────────

/** Empreinte de l'anomalie de supervision d'un compte. */
export const t6EvaluationAnomalyFingerprint = (accountId: number) => `ai:t6-evaluation:${accountId}`;
export const T6_EVALUATION_ANOMALY_PREFIX = 'ai:t6-evaluation:';

export interface T6SupervisionAccount {
  accountId: number;
  failed: number;
  stalePending: number;
  staleRunning: number;
  overdueRetry: number;
  oldestSince: string | null;
  kinds: Record<string, number>;
}

export interface T6SupervisionResult { blockedAccounts: number; reported: number; resolved: number; schedulerInactive: boolean }

/**
 * Comptes dont des évaluations sont BLOQUÉES ou EN ÉCHEC : tentatives
 * épuisées (FAILED), demande non prise au-delà du délai, exécution
 * interrompue non reprise, essai planifié dû et non exécuté. Borné.
 */
export async function blockedT6Accounts(alertMinutes = t6PendingAlertMinutes(), limit = 200): Promise<T6SupervisionAccount[]> {
  const r = await q(
    `SELECT account_id,
            count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
            count(*) FILTER (WHERE status = 'PENDING' AND requested_at < now() - make_interval(mins => $1::int))::int AS stale_pending,
            count(*) FILTER (WHERE status = 'RUNNING' AND lease_until < now() - make_interval(mins => $1::int))::int AS stale_running,
            count(*) FILTER (WHERE status IN ('RETRY_WAIT', 'UNAVAILABLE') AND next_attempt_at < now() - make_interval(mins => $1::int))::int AS overdue_retry,
            min(CASE WHEN status = 'PENDING' THEN requested_at WHEN status = 'RUNNING' THEN lease_until ELSE coalesce(next_attempt_at, finished_at) END) AS oldest,
            jsonb_object_agg(coalesce(last_error_kind, 'none'), 1) AS kinds
       FROM t6_evaluation_runs
      WHERE status <> 'COMPLETED'
      GROUP BY account_id
     HAVING count(*) FILTER (WHERE status = 'FAILED'
                             OR (status = 'PENDING' AND requested_at < now() - make_interval(mins => $1::int))
                             OR (status = 'RUNNING' AND lease_until < now() - make_interval(mins => $1::int))
                             OR (status IN ('RETRY_WAIT', 'UNAVAILABLE') AND next_attempt_at < now() - make_interval(mins => $1::int))) > 0
      ORDER BY account_id
      LIMIT $2`,
    [alertMinutes, limit],
  );
  return r.map((x) => ({
    accountId: Number(x.account_id), failed: Number(x.failed), stalePending: Number(x.stale_pending), staleRunning: Number(x.stale_running),
    overdueRetry: Number(x.overdue_retry), oldestSince: iso(x.oldest), kinds: (x.kinds ?? {}) as Record<string, number>,
  }));
}

/** La tâche `mascot-pregeneration` tourne-t-elle (dernier passage récent, non suspendue) ? Ne lève jamais. */
export async function pregenSchedulerActive(maxSilenceMinutes = 10): Promise<boolean> {
  try {
    const [r] = await q(
      `SELECT (COALESCE((to_jsonb(s) ->> 'admin_disabled')::boolean, false) = false
               AND coalesce(s.last_finished_at, s.last_started_at) > now() - make_interval(mins => $1::int)) AS ok
         FROM scheduled_task_state s WHERE s.code = 'mascot-pregeneration'`,
      [maxSilenceMinutes],
    );
    return r?.ok === true;
  } catch {
    return true; // état illisible : jamais d'accusation sans preuve
  }
}

/**
 * Diagnostic d'un compte bloqué (pur) : causes distinguées — modèle
 * indisponible, sortie invalide / décisions rejetées, échec d'écriture,
 * traitement interrompu, plafond IA, tâche planifiée inactive.
 */
export function t6BlockedDiagnosis(a: T6SupervisionAccount, schedulerActive: boolean): { causes: string[]; summary: string } {
  const causes = new Set<string>();
  for (const k of Object.keys(a.kinds)) if (k !== 'none') causes.add(k);
  if (a.staleRunning > 0) causes.add('interrupted');
  if (!schedulerActive && (a.stalePending > 0 || a.overdueRetry > 0 || a.staleRunning > 0)) causes.add('scheduler_inactive');
  if (causes.size === 0 && a.stalePending > 0) causes.add('not_picked_up');
  const parts = [
    a.failed ? `${a.failed} en échec (tentatives épuisées)` : null,
    a.stalePending ? `${a.stalePending} demandée(s) non prise(s) en charge` : null,
    a.staleRunning ? `${a.staleRunning} interrompue(s) non reprise(s)` : null,
    a.overdueRetry ? `${a.overdueRetry} nouvel(s) essai(s) dû(s) non exécuté(s)` : null,
  ].filter(Boolean);
  return { causes: [...causes].sort(), summary: parts.join(', ') };
}

/**
 * Supervision des évaluations T6 : une anomalie (BO › Supervision, domaine
 * IA) par compte bloqué ou en échec, consolidée ; résolue automatiquement
 * quand le compte n'a plus d'évaluation bloquée. Ne lève jamais.
 */
export async function superviseT6Evaluations(opts: {
  alertMinutes?: number; onlyAccountId?: number | null;
  report?: (a: import('@/services/admin/anomaly.service').ReportAnomalyInput) => Promise<unknown>;
  resolve?: (fingerprint: string, o: { origin: string; cause?: string | null }) => Promise<unknown>;
} = {}): Promise<T6SupervisionResult> {
  const out: T6SupervisionResult = { blockedAccounts: 0, reported: 0, resolved: 0, schedulerInactive: false };
  try {
    if (!(await t6RunsReady())) return out;
    const alertMinutes = opts.alertMinutes ?? t6PendingAlertMinutes();
    const anomaly = await import('@/services/admin/anomaly.service');
    const report = opts.report ?? anomaly.reportAnomaly;
    const resolve = opts.resolve ?? anomaly.autoResolveAnomaly;
    let bloques = await blockedT6Accounts(alertMinutes);
    if (opts.onlyAccountId != null) bloques = bloques.filter((a) => a.accountId === opts.onlyAccountId);
    const actif = await pregenSchedulerActive();
    out.schedulerInactive = !actif;
    out.blockedAccounts = bloques.length;
    for (const a of bloques) {
      const d = t6BlockedDiagnosis(a, actif);
      await report({
        domain: 'ai', fingerprint: t6EvaluationAnomalyFingerprint(a.accountId), accountId: a.accountId,
        title: `T6 : évaluations d’échéances bloquées ou en échec (${d.summary})`,
        detail: {
          kind: 't6_evaluation', accountId: a.accountId, operation: 't6_evaluate', causes: d.causes, failed: a.failed, stalePending: a.stalePending,
          staleRunning: a.staleRunning, overdueRetry: a.overdueRetry, oldestSince: a.oldestSince, alertMinutes, schedulerActive: actif,
        },
      });
      out.reported += 1;
    }
    // Retour à la normale : anomalies ouvertes des comptes qui ne sont plus bloqués.
    const ouvertes = await q(
      `SELECT fingerprint, account_id FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE $1 LIMIT 500`,
      [`${T6_EVALUATION_ANOMALY_PREFIX}%`],
    );
    const encore = new Set(bloques.map((a) => t6EvaluationAnomalyFingerprint(a.accountId)));
    for (const o of ouvertes) {
      const fp = String(o.fingerprint);
      if (encore.has(fp)) continue;
      if (opts.onlyAccountId != null && fp !== t6EvaluationAnomalyFingerprint(opts.onlyAccountId)) continue;
      if (await resolve(fp, { origin: 't6_evaluations_completed', cause: 'évaluations terminées ou relancées' })) out.resolved += 1;
    }
  } catch (e) {
    console.error('[mascotte] supervision des évaluations T6 impossible :', (e as Error).message);
  }
  return out;
}
