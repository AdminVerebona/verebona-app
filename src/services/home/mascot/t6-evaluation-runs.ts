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
import { processingEligibleSql } from '@/services/account/processing-eligibility';
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
  | 'model_unavailable' | 'invalid_output' | 'rejected' | 'write_failed' | 'interrupted' | 'cost_cap' | 'scheduler_inactive'
  /** Lot 81B (B) : T6 désactivé, suspendu, arrêt d'urgence ou prompt sans EVALUATE — reprise au rétablissement. */
  | 't6_unavailable'
  /** Lot 81B (C) : tentatives de la DEMANDE de pré-génération épuisées sans progrès. */
  | 'pregen_exhausted'
  /** Lot 81B (D) : exécution dépossédée (bail repris par une autre instance) — rien écrit. */
  | 'ownership_lost';

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
/**
 * Lot 81B (B) : T6 indisponible — nouvelle vérification (sans appel IA) au
 * plus tôt dans ce délai ; au rétablissement, l'évaluation redevient
 * prenable aussitôt (`requestT6Runs`).
 */
export const T6_RUN_UNAVAILABLE_RECHECK_S = 15 * 60;
/**
 * Lot 81B (D) : renouvellement du bail pendant l'exécution (toutes les
 * `T6_RUN_LEASE_MS / 3`), au plus `T6_RUN_LEASE_MAX_MS` après la prise — une
 * exécution bloquée ne retient jamais l'évaluation indéfiniment.
 */
export const T6_RUN_RENEW_EVERY_MS = Math.floor(T6_RUN_LEASE_MS / 3);
export const T6_RUN_LEASE_MAX_MS = 30 * 60_000;

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
  // Lot 81B (B) : T6 rétabli — les évaluations non exécutées pour cause
  // d'indisponibilité redeviennent prenables AUSSITÔT (sans nouvelle visite ni
  // attente du délai de vérification), tentatives conservées.
  await releaseT6UnavailableRuns(accountId, subjects.map((s) => s.agendaItemId));
  const r = await q(`${UPSERT_DEMANDE(T6_RUN_COMPLETED_COOLDOWN_MS / 1000)} RETURNING agenda_item_id`, [
    accountId, subjects.map((s) => s.agendaItemId), subjects.map((s) => s.fingerprint), subjects.map((s) => s.signature),
  ]);
  return r.length;
}

/**
 * Lot 81B (B) — T6 INDISPONIBLE (désactivé, suspendu, arrêt d'urgence, prompt
 * sans branche EVALUATE) : les évaluations éligibles sont ENREGISTRÉES avec
 * un état explicite (UNAVAILABLE, `t6_unavailable`, nouvelle vérification à
 * `T6_RUN_UNAVAILABLE_RECHECK_S`) — jamais absentes, jamais PENDING. Une
 * exécution vivante, une décision enregistrée ou un échec définitif du MÊME
 * contexte ne sont pas touchés ; une indisponibilité d'une autre nature
 * (plafond IA du compte, tentatives de pré-génération épuisées) garde son
 * motif. Tentatives conservées (aucune remise à zéro). Rend les échéances
 * marquées. Lève si la base échoue.
 */
export async function markT6RunsUnavailable(accountId: number, subjects: readonly T6RunSubject[], o: {
  kind?: T6RunErrorKind; error?: string; recheckS?: number;
} = {}): Promise<number[]> {
  if (subjects.length === 0) return [];
  const kind = o.kind ?? 't6_unavailable';
  const recheck = Math.max(1, Math.floor(o.recheckS ?? T6_RUN_UNAVAILABLE_RECHECK_S));
  const r = await q(
    `INSERT INTO t6_evaluation_runs (agenda_item_id, account_id, status, context_fingerprint, evaluation_signature, requested_at,
                                     finished_at, next_attempt_at, last_error_kind, last_error, last_outcome)
     SELECT i.id, $1, 'UNAVAILABLE', m.fp, m.sig, now(), now(), now() + make_interval(secs => $5::int), $6, left($7, 500), 'non exécutée : T6 indisponible'
       FROM unnest($2::int[], $3::text[], $4::text[]) AS m(id, fp, sig)
       JOIN agenda_items i ON i.id = m.id AND i.account_id = $1
     ON CONFLICT (agenda_item_id) DO UPDATE SET
       account_id = EXCLUDED.account_id, status = 'UNAVAILABLE',
       attempts = CASE WHEN ${MEME_CONTEXTE} THEN t6_evaluation_runs.attempts ELSE 0 END,
       requested_at = CASE WHEN ${MEME_CONTEXTE} THEN t6_evaluation_runs.requested_at ELSE now() END,
       same_context_runs = CASE WHEN ${MEME_CONTEXTE} THEN t6_evaluation_runs.same_context_runs ELSE 0 END,
       context_fingerprint = EXCLUDED.context_fingerprint, evaluation_signature = EXCLUDED.evaluation_signature,
       interrupted_count = t6_evaluation_runs.interrupted_count + CASE WHEN t6_evaluation_runs.status = 'RUNNING' THEN 1 ELSE 0 END,
       run_id = NULL, lease_until = NULL, finished_at = now(),
       next_attempt_at = CASE WHEN ${MEME_CONTEXTE}
                              THEN GREATEST(coalesce(t6_evaluation_runs.next_attempt_at, now()), EXCLUDED.next_attempt_at)
                              ELSE EXCLUDED.next_attempt_at END,
       last_error_kind = EXCLUDED.last_error_kind, last_error = EXCLUDED.last_error, last_outcome = EXCLUDED.last_outcome,
       updated_at = now()
     WHERE NOT (t6_evaluation_runs.status = 'RUNNING' AND t6_evaluation_runs.lease_until > now())
       AND (NOT (${MEME_CONTEXTE})
            OR t6_evaluation_runs.status IN ('PENDING', 'RETRY_WAIT', 'RUNNING')
            -- Déjà indisponible pour ce motif : réécrite seulement à l'échéance de
            -- la vérification (aucune écriture à chaque visite).
            OR (t6_evaluation_runs.status = 'UNAVAILABLE' AND t6_evaluation_runs.last_error_kind = $6
                AND coalesce(t6_evaluation_runs.next_attempt_at, '-infinity'::timestamptz) <= now()))
     RETURNING agenda_item_id`,
    [accountId, subjects.map((s) => s.agendaItemId), subjects.map((s) => s.fingerprint), subjects.map((s) => s.signature),
      recheck, kind, o.error ?? 'T6 indisponible (désactivé, suspendu ou arrêt d’urgence)'],
  );
  return r.map((x) => Number(x.agenda_item_id));
}

/**
 * Lot 81B (B) — rétablissement de T6 : les évaluations `t6_unavailable` des
 * échéances données redeviennent prenables tout de suite (PENDING, ou essai
 * dû si des tentatives avaient déjà eu lieu). Rend le nombre libéré.
 */
export async function releaseT6UnavailableRuns(accountId: number, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await q(
    `UPDATE t6_evaluation_runs SET
       status = CASE WHEN attempts > 0 THEN 'RETRY_WAIT' ELSE 'PENDING' END,
       next_attempt_at = CASE WHEN attempts > 0 THEN now() ELSE NULL END,
       requested_at = CASE WHEN attempts > 0 THEN requested_at ELSE now() END,
       last_outcome = 'T6 rétabli : reprise', updated_at = now()
     WHERE account_id = $1 AND agenda_item_id = ANY($2::int[]) AND status = 'UNAVAILABLE' AND last_error_kind = 't6_unavailable'
     RETURNING agenda_item_id`,
    [accountId, [...ids]],
  );
  return r.length;
}

/**
 * Lot 81B (C) — tentatives de la DEMANDE de pré-génération épuisées sans
 * progrès : aucune évaluation du compte ne reste PENDING « orpheline ». Les
 * demandes non prises (et les exécutions au bail expiré) passent
 * UNAVAILABLE (`pregen_exhausted`) avec la date de reprise automatique
 * (`retryAt`), ou sans date (reprise explicite : BO, visite) — état explicite,
 * signalé par la supervision. Rend le nombre d'évaluations marquées.
 */
export async function markT6RunsPregenExhausted(accountId: number, retryAt: Date | null): Promise<number> {
  const r = await q(
    `UPDATE t6_evaluation_runs SET
       status = 'UNAVAILABLE', last_error_kind = 'pregen_exhausted',
       last_error = 'tentatives de la pré-génération épuisées sans progrès',
       last_outcome = CASE WHEN $2::timestamptz IS NULL THEN 'reprise explicite requise (BO › Supervision)' ELSE 'reprise automatique planifiée' END,
       interrupted_count = interrupted_count + CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END,
       run_id = NULL, lease_until = NULL, finished_at = now(), next_attempt_at = $2::timestamptz, updated_at = now()
     WHERE account_id = $1 AND (status = 'PENDING' OR (status = 'RUNNING' AND lease_until <= now()))
     RETURNING agenda_item_id`,
    [accountId, retryAt ? retryAt.toISOString() : null],
  );
  return r.length;
}

/**
 * Lot 81B (G) — CLÔTURE RATTRAPÉE : une décision valide est enregistrée pour
 * ce contexte (empreinte identique) mais l'état durable n'a pas été clos
 * (clôture technique en échec après la persistance métier) — l'évaluation
 * passe COMPLETED, sans nouvel appel IA. Jamais pendant une exécution
 * vivante. Rend les échéances rattrapées.
 */
export async function reconcileT6RunsWithDecision(accountId: number, subjects: ReadonlyArray<{ agendaItemId: number; fingerprint: string | null }>): Promise<number[]> {
  const sujets = subjects.filter((x) => !!x.fingerprint);
  if (sujets.length === 0) return [];
  const r = await q(
    `UPDATE t6_evaluation_runs r SET status = 'COMPLETED', run_id = NULL, lease_until = NULL, next_attempt_at = NULL,
            finished_at = now(), last_error_kind = NULL, last_error = NULL,
            last_outcome = 'décision enregistrée constatée : clôture rattrapée', updated_at = now()
       FROM unnest($2::int[], $3::text[]) AS m(id, fp)
      WHERE r.account_id = $1 AND r.agenda_item_id = m.id AND r.context_fingerprint = m.fp
        AND r.status <> 'COMPLETED' AND NOT (r.status = 'RUNNING' AND r.lease_until > now())
     RETURNING r.agenda_item_id`,
    [accountId, sujets.map((x) => x.agendaItemId), sujets.map((x) => x.fingerprint)],
  );
  return r.map((x) => Number(x.agenda_item_id));
}

/**
 * Lot 81B (D) — RENOUVELLEMENT du bail pendant l'exécution : seules les
 * lignes encore détenues par `runId` (RUNNING) sont prolongées. Rend les
 * échéances encore détenues ; une ligne absente = propriété PERDUE (bail
 * repris par une autre instance) : l'exécution ne doit plus rien écrire.
 */
export async function renewT6Runs(p: { accountId: number; runId: string; ids: readonly number[]; leaseMs?: number }): Promise<number[]> {
  if (p.ids.length === 0) return [];
  const lease = Math.max(1, Math.floor((p.leaseMs ?? T6_RUN_LEASE_MS) / 1000));
  const r = await q(
    `UPDATE t6_evaluation_runs SET lease_until = now() + make_interval(secs => $4::int), updated_at = now()
      WHERE account_id = $1 AND run_id = $2 AND status = 'RUNNING' AND agenda_item_id = ANY($3::int[])
     RETURNING agenda_item_id`,
    [p.accountId, p.runId, [...p.ids], lease],
  );
  return r.map((x) => Number(x.agenda_item_id));
}

/**
 * Lot 81B (D) — CONTRÔLE DE PROPRIÉTÉ au moment de la persistance métier,
 * DANS la transaction d'écriture des décisions : verrou consultatif du compte
 * (le même que la prise : aucune reprise concurrente pendant l'écriture),
 * puis verrou des lignes encore détenues par `runId`, dont le bail est
 * prolongé jusqu'à la clôture. Rend les échéances détenues : seules leurs
 * décisions peuvent être écrites — une instance dépossédée n'écrase jamais
 * la décision d'une exécution plus récente.
 */
export async function lockOwnedT6Runs(
  tq: (sql: string, params: unknown[]) => Promise<Row[]>,
  p: { accountId: number; runId: string; ids: readonly number[]; leaseMs?: number },
): Promise<Set<number>> {
  if (p.ids.length === 0) return new Set();
  const lease = Math.max(1, Math.floor((p.leaseMs ?? T6_RUN_LEASE_MS) / 1000));
  await tq(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [T6_RUN_LOCK_SPACE, p.accountId]);
  const r = await tq(
    `UPDATE t6_evaluation_runs SET lease_until = GREATEST(coalesce(lease_until, now()), now() + make_interval(secs => $4::int)), updated_at = now()
      WHERE agenda_item_id IN (
        SELECT agenda_item_id FROM t6_evaluation_runs
         WHERE account_id = $1 AND run_id = $2 AND status = 'RUNNING' AND agenda_item_id = ANY($3::int[])
         ORDER BY agenda_item_id FOR UPDATE)
     RETURNING agenda_item_id`,
    [p.accountId, p.runId, [...p.ids], lease],
  );
  return new Set(r.map((x) => Number(x.agenda_item_id)));
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
  /** Essai planifié dû et non exécuté, ou indisponibilité sans reprise planifiée. */
  overdueRetry: number;
  oldestSince: string | null;
  /** Lot 81B (E) : nombre d'évaluations BLOQUÉES par cause (et non un simple drapeau). */
  kinds: Record<string, number>;
  /** Lot 81B (C) : demande de pré-génération aux tentatives épuisées, évaluations encore incomplètes. */
  pregenExhausted?: boolean;
  /** Lot 81B : évaluations non abouties du compte (bloquées ou non). */
  incomplete?: number;
}

export interface T6SupervisionResult {
  blockedAccounts: number;
  reported: number;
  resolved: number;
  schedulerInactive: boolean;
  /** Lot 81B (E) : balayage complet (toutes les pages lues) ; faux : aucune conclusion sur les comptes non lus. */
  complete?: boolean;
  pages?: number;
  /** Lot 81B (E) : anomalies ouvertes contrôlées une à une (retour à la normale vérifié). */
  verified?: number;
  /** Lot 81B (F) : anomalie « tâche de pré-génération inactive » signalée / résolue. */
  schedulerReported?: boolean;
  schedulerResolved?: boolean;
  /** Lot 81B : supervision interrompue (base) — la tâche planifiée le signale en échec. */
  error?: string | null;
}

/** Lot 81B (E) : taille d'une page du balayage de supervision. */
export const T6_SUPERVISION_PAGE_SIZE = 200;
/** Lot 81B (E) : pages au plus par passage (au-delà : balayage incomplet, rien n'est résolu par absence). */
export const T6_SUPERVISION_MAX_PAGES = 500;

/**
 * Comptes dont des évaluations sont BLOQUÉES ou EN ÉCHEC : tentatives
 * épuisées (FAILED), demande non prise au-delà du délai, exécution
 * interrompue non reprise, essai planifié dû et non exécuté, indisponibilité
 * sans reprise planifiée ; lot 81B (C) : ou demande de pré-génération aux
 * tentatives épuisées avec des évaluations encore incomplètes.
 *
 * Lot 81B (E) — UNE PAGE, triée par compte (pagination par clé : `afterAccountId`) ;
 * filtre d'un compte APPLIQUÉ DANS LA REQUÊTE (`onlyAccountId`). Les causes
 * sont comptées sur les seules évaluations bloquées.
 */
export async function blockedT6Accounts(
  alertMinutes = t6PendingAlertMinutes(),
  opts: number | { limit?: number; afterAccountId?: number; onlyAccountId?: number | null } = {},
): Promise<T6SupervisionAccount[]> {
  const o = typeof opts === 'number' ? { limit: opts } : opts;
  const limit = Math.max(1, Math.floor(o.limit ?? T6_SUPERVISION_PAGE_SIZE));
  const r = await q(
    `WITH x AS (
       SELECT account_id, coalesce(last_error_kind, 'none') AS kind,
              status = 'FAILED' AS f,
              (status = 'PENDING' AND requested_at < now() - make_interval(mins => $1::int)) AS sp,
              (status = 'RUNNING' AND lease_until < now() - make_interval(mins => $1::int)) AS sr,
              (status IN ('RETRY_WAIT', 'UNAVAILABLE')
               AND (next_attempt_at IS NULL OR next_attempt_at < now() - make_interval(mins => $1::int))) AS od,
              CASE WHEN status = 'PENDING' THEN requested_at WHEN status = 'RUNNING' THEN lease_until
                   ELSE coalesce(next_attempt_at, finished_at) END AS since
         FROM t6_evaluation_runs
        WHERE status <> 'COMPLETED' AND ($3::int IS NULL OR account_id = $3::int) AND account_id > $4::int
          -- Lot 82A (C-Q10) : un compte non éligible ne reçoit aucun traitement ;
          -- ses évaluations en attente ne sont pas des blocages (reprise à la réactivation).
          AND ${processingEligibleSql('t6_evaluation_runs.account_id')}
     ), e AS (
       SELECT account_id FROM home_mascot_pregen_requests
        WHERE last_status = 'attempts_exhausted' AND ($3::int IS NULL OR account_id = $3::int) AND account_id > $4::int
          AND ${processingEligibleSql('home_mascot_pregen_requests.account_id')}
     ), y AS (
       SELECT x.*, (x.f OR x.sp OR x.sr OR x.od) AS bloquee, (e.account_id IS NOT NULL) AS epuisee
         FROM x LEFT JOIN e ON e.account_id = x.account_id
     ), k AS (
       SELECT account_id, jsonb_object_agg(kind, n) AS kinds
         FROM (SELECT account_id, kind, count(*)::int AS n FROM y WHERE bloquee OR epuisee GROUP BY account_id, kind) z
        GROUP BY account_id
     )
     SELECT y.account_id,
            count(*) FILTER (WHERE f)::int AS failed,
            count(*) FILTER (WHERE sp)::int AS stale_pending,
            count(*) FILTER (WHERE sr)::int AS stale_running,
            count(*) FILTER (WHERE od)::int AS overdue_retry,
            count(*)::int AS incomplete,
            bool_or(epuisee) AS pregen_exhausted,
            min(since) FILTER (WHERE bloquee OR epuisee) AS oldest,
            max(k.kinds::text)::jsonb AS kinds
       FROM y LEFT JOIN k ON k.account_id = y.account_id
      GROUP BY y.account_id
     HAVING count(*) FILTER (WHERE bloquee) > 0 OR bool_or(epuisee)
      ORDER BY y.account_id
      LIMIT $2`,
    [alertMinutes, limit, o.onlyAccountId ?? null, o.afterAccountId ?? 0],
  );
  return r.map((x) => ({
    accountId: Number(x.account_id), failed: Number(x.failed), stalePending: Number(x.stale_pending), staleRunning: Number(x.stale_running),
    overdueRetry: Number(x.overdue_retry), oldestSince: iso(x.oldest), kinds: (x.kinds ?? {}) as Record<string, number>,
    pregenExhausted: x.pregen_exhausted === true, incomplete: Number(x.incomplete ?? 0),
  }));
}

export const PREGEN_TASK_CODE = 'mascot-pregeneration';

/** Lot 81B (F) : état de la tâche de pré-génération, lu dans l'état du planificateur (`scheduled_task_state`). */
export interface PregenSchedulerState {
  /** `unknown` : état illisible — jamais une accusation, jamais une résolution. */
  state: 'active' | 'inactive' | 'unknown';
  adminDisabled?: boolean;
  envDisabled?: boolean;
  lastFinishedAt?: string | null;
  lastSuccessAt?: string | null;
}

/**
 * Lot 81B (F) — la tâche `mascot-pregeneration` tourne-t-elle ? Lu dans
 * l'état PARTAGÉ du planificateur (pas dans la tâche elle-même) : arrêtée
 * par variable, suspendue depuis le BO, ou sans passage terminé depuis
 * `maxSilenceMinutes` → inactive. Ne lève jamais.
 */
export async function pregenSchedulerState(maxSilenceMinutes = 10, env: Record<string, string | undefined> = process.env): Promise<PregenSchedulerState> {
  try {
    const { isTaskEnabled } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const envDisabled = !isTaskEnabled(PREGEN_TASK_CODE, env);
    const [r] = await q(
      `SELECT COALESCE((to_jsonb(s) ->> 'admin_disabled')::boolean, false) AS admin_disabled,
              coalesce(s.last_finished_at, s.last_started_at) > now() - make_interval(mins => $1::int) AS recent,
              coalesce(s.last_finished_at, s.last_started_at) AS last_finished_at, s.last_success_at
         FROM scheduled_task_state s WHERE s.code = $2`,
      [maxSilenceMinutes, PREGEN_TASK_CODE],
    );
    const base = {
      adminDisabled: r?.admin_disabled === true, envDisabled,
      lastFinishedAt: iso(r?.last_finished_at ?? null), lastSuccessAt: iso(r?.last_success_at ?? null),
    };
    // Ligne absente : la tâche n'a jamais tourné.
    const actif = !envDisabled && !!r && r.admin_disabled !== true && r.recent === true;
    return { state: actif ? 'active' : 'inactive', ...base };
  } catch {
    return { state: 'unknown' };
  }
}

/** La tâche `mascot-pregeneration` tourne-t-elle (dernier passage récent, non suspendue) ? Ne lève jamais. */
export async function pregenSchedulerActive(maxSilenceMinutes = 10): Promise<boolean> {
  // État illisible : jamais d'accusation sans preuve.
  return (await pregenSchedulerState(maxSilenceMinutes)).state !== 'inactive';
}

/**
 * Diagnostic d'un compte bloqué (pur) : causes distinguées — modèle
 * indisponible, sortie invalide / décisions rejetées, échec d'écriture,
 * traitement interrompu, plafond IA, tâche planifiée inactive ; lot 81B :
 * T6 indisponible, tentatives de pré-génération épuisées, dépossession.
 */
export function t6BlockedDiagnosis(a: T6SupervisionAccount, schedulerActive: boolean): { causes: string[]; summary: string } {
  const causes = new Set<string>();
  for (const k of Object.keys(a.kinds)) if (k !== 'none') causes.add(k);
  if (a.staleRunning > 0) causes.add('interrupted');
  if (a.pregenExhausted) causes.add('pregen_exhausted');
  if (!schedulerActive && (a.stalePending > 0 || a.overdueRetry > 0 || a.staleRunning > 0 || a.pregenExhausted)) causes.add('scheduler_inactive');
  if (causes.size === 0 && a.stalePending > 0) causes.add('not_picked_up');
  const parts = [
    a.failed ? `${a.failed} en échec (tentatives épuisées)` : null,
    a.stalePending ? `${a.stalePending} demandée(s) non prise(s) en charge` : null,
    a.staleRunning ? `${a.staleRunning} interrompue(s) non reprise(s)` : null,
    a.overdueRetry ? `${a.overdueRetry} nouvel(s) essai(s) dû(s) non exécuté(s)` : null,
    a.pregenExhausted ? `pré-génération aux tentatives épuisées (${a.incomplete ?? 0} évaluation(s) incomplète(s))` : null,
  ].filter(Boolean);
  return { causes: [...causes].sort(), summary: parts.join(', ') };
}

/** Lot 81B (F) : empreinte de l'anomalie « tâche de pré-génération inactive, évaluations en attente ». */
export const T6_PREGEN_SCHEDULER_ANOMALY = 'ai:t6-pregen-scheduler';

/** Compte d'une empreinte d'anomalie de compte (pure) ; `null` si ce n'en est pas une. */
export function accountOfT6Anomaly(fingerprint: string): number | null {
  if (!fingerprint.startsWith(T6_EVALUATION_ANOMALY_PREFIX)) return null;
  const n = Number(fingerprint.slice(T6_EVALUATION_ANOMALY_PREFIX.length));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Supervision des évaluations T6 : une anomalie (BO › Supervision, domaine
 * IA) par compte bloqué ou en échec, consolidée ; résolue automatiquement
 * quand le compte n'a plus d'évaluation bloquée. Ne lève jamais.
 *
 * Lot 81B (E) — balayage PAGINÉ sans perte de comptes (clé : compte) ; filtre
 * d'un compte dans la requête ; une anomalie ouverte n'est JAMAIS résolue
 * parce que son compte manque d'un résultat borné : le retour à la normale
 * est vérifié POSITIVEMENT, compte par compte (requête ciblée) — encore
 * bloqué, l'anomalie est maintenue (et actualisée).
 *
 * Lot 81B (F) — tâche de pré-génération inactive (état du planificateur) :
 * cause `scheduler_inactive` des comptes bloqués et anomalie globale
 * (`T6_PREGEN_SCHEDULER_ANOMALY`) identifiant les comptes dont des
 * évaluations attendent, résolue quand la tâche est de nouveau active.
 * Appelée par la tâche planifiée DISTINCTE `mascot-t6-supervision`.
 */
export async function superviseT6Evaluations(opts: {
  alertMinutes?: number; onlyAccountId?: number | null;
  report?: (a: import('@/services/admin/anomaly.service').ReportAnomalyInput) => Promise<unknown>;
  resolve?: (fingerprint: string, o: { origin: string; cause?: string | null }) => Promise<unknown>;
  /** Lot 81B : taille de page et pages au plus (tests). */
  pageSize?: number; maxPages?: number;
  /** Lot 81B : état de la tâche de pré-génération (injectable). */
  scheduler?: () => Promise<PregenSchedulerState>;
} = {}): Promise<T6SupervisionResult> {
  const out: T6SupervisionResult = { blockedAccounts: 0, reported: 0, resolved: 0, schedulerInactive: false, complete: false, pages: 0, verified: 0 };
  try {
    if (!(await t6RunsReady())) return out;
    const alertMinutes = opts.alertMinutes ?? t6PendingAlertMinutes();
    const anomaly = await import('@/services/admin/anomaly.service');
    const report = opts.report ?? anomaly.reportAnomaly;
    const resolve = opts.resolve ?? anomaly.autoResolveAnomaly;
    const pageSize = Math.max(1, Math.floor(opts.pageSize ?? T6_SUPERVISION_PAGE_SIZE));
    const maxPages = Math.max(1, Math.floor(opts.maxPages ?? T6_SUPERVISION_MAX_PAGES));
    const ordo = await (opts.scheduler ?? (() => pregenSchedulerState()))();
    const actif = ordo.state !== 'inactive';
    out.schedulerInactive = !actif;
    const signaler = async (a: T6SupervisionAccount) => {
      const d = t6BlockedDiagnosis(a, actif);
      await report({
        domain: 'ai', fingerprint: t6EvaluationAnomalyFingerprint(a.accountId), accountId: a.accountId,
        title: `T6 : évaluations d’échéances bloquées ou en échec (${d.summary})`,
        detail: {
          kind: 't6_evaluation', accountId: a.accountId, operation: 't6_evaluate', causes: d.causes, failed: a.failed, stalePending: a.stalePending,
          staleRunning: a.staleRunning, overdueRetry: a.overdueRetry, oldestSince: a.oldestSince, alertMinutes, schedulerActive: actif,
          kinds: a.kinds, pregenExhausted: a.pregenExhausted === true, incomplete: a.incomplete ?? null,
        },
      });
      out.reported += 1;
    };
    // 1. Balayage paginé (clé : compte) — jamais tronqué en silence.
    const bloques = new Set<number>();
    let apres = 0;
    let pages = 0;
    for (;;) {
      const page = await blockedT6Accounts(alertMinutes, { limit: pageSize, afterAccountId: apres, onlyAccountId: opts.onlyAccountId ?? null });
      pages += 1;
      out.pages = pages;
      for (const a of page) {
        bloques.add(a.accountId);
        await signaler(a);
      }
      if (page.length < pageSize) { out.complete = true; break; }
      apres = page[page.length - 1].accountId;
      if (pages >= maxPages) break;
    }
    out.blockedAccounts = bloques.size;
    // 2. Retour à la normale : chaque anomalie ouverte (paginée, filtrée sur le
    //    compte dans la requête) est contrôlée POSITIVEMENT avant résolution.
    const seul = opts.onlyAccountId != null ? t6EvaluationAnomalyFingerprint(opts.onlyAccountId) : null;
    let dernier = 0;
    for (;;) {
      const ouvertes = await q(
        `SELECT id, fingerprint FROM admin_anomalies
          WHERE status = 'open' AND fingerprint LIKE $1 AND ($2::text IS NULL OR fingerprint = $2) AND id > $3
          ORDER BY id LIMIT 500`,
        [`${T6_EVALUATION_ANOMALY_PREFIX}%`, seul, dernier],
      );
      for (const o of ouvertes) {
        dernier = Number(o.id);
        const fp = String(o.fingerprint);
        const compte = accountOfT6Anomaly(fp);
        if (compte == null || bloques.has(compte)) continue;
        try {
          const encore = await blockedT6Accounts(alertMinutes, { limit: 1, onlyAccountId: compte });
          out.verified = (out.verified ?? 0) + 1;
          if (encore.length > 0) {
            // Absent d'un résultat borné mais toujours bloqué : maintenue.
            bloques.add(compte);
            await signaler(encore[0]);
            continue;
          }
          if (await resolve(fp, { origin: 't6_evaluations_completed', cause: 'évaluations terminées ou relancées (vérifié)' })) out.resolved += 1;
        } catch (e) {
          // Vérification impossible : l'anomalie reste ouverte.
          console.error('[mascotte] supervision T6 : vérification du compte impossible —', (e as Error).message);
        }
      }
      if (ouvertes.length < 500) break;
    }
    out.blockedAccounts = bloques.size;
    // 3. Tâche de pré-génération inactive (balayage global seulement).
    if (opts.onlyAccountId == null) await superviseScheduler(ordo, report, resolve, out);
  } catch (e) {
    out.error = (e as Error).message?.slice(0, 300) ?? 'erreur';
    console.error('[mascotte] supervision des évaluations T6 impossible :', out.error);
  }
  return out;
}

/**
 * Lot 81B (F) — anomalie globale quand la tâche `mascot-pregeneration` est
 * inactive ET que des évaluations ou des demandes de pré-génération
 * attendent : comptes identifiés (nombre et premiers identifiants). Résolue
 * seulement sur preuve que la tâche tourne de nouveau.
 */
async function superviseScheduler(
  ordo: PregenSchedulerState,
  report: (a: import('@/services/admin/anomaly.service').ReportAnomalyInput) => Promise<unknown>,
  resolve: (fingerprint: string, o: { origin: string; cause?: string | null }) => Promise<unknown>,
  out: T6SupervisionResult,
): Promise<void> {
  if (ordo.state === 'active') {
    out.schedulerResolved = !!(await resolve(T6_PREGEN_SCHEDULER_ANOMALY, { origin: 'pregen_scheduler_active', cause: 'tâche de pré-génération de nouveau active' }));
    return;
  }
  if (ordo.state !== 'inactive') return;
  const [r] = await q(
    // Lot 82A (C-Q10) : comptes éligibles seulement (les autres n'attendent rien).
    `SELECT (SELECT count(DISTINCT account_id) FROM t6_evaluation_runs WHERE status NOT IN ('COMPLETED', 'FAILED')
               AND ${processingEligibleSql('t6_evaluation_runs.account_id')})::int AS accounts,
            (SELECT array_agg(account_id ORDER BY account_id) FROM (
               SELECT DISTINCT account_id FROM t6_evaluation_runs WHERE status NOT IN ('COMPLETED', 'FAILED')
                  AND ${processingEligibleSql('t6_evaluation_runs.account_id')} ORDER BY account_id LIMIT 50) z) AS ids,
            (SELECT count(*) FROM home_mascot_pregen_requests WHERE (processed_at IS NULL OR requested_at > processed_at)
               AND ${processingEligibleSql('home_mascot_pregen_requests.account_id')})::int AS requests`,
    [],
  );
  const comptes = Number(r?.accounts ?? 0);
  const demandes = Number(r?.requests ?? 0);
  if (comptes === 0 && demandes === 0) return;
  await report({
    domain: 'ai', fingerprint: T6_PREGEN_SCHEDULER_ANOMALY,
    title: `Tâche « mascot-pregeneration » inactive : ${comptes} compte(s) avec des évaluations T6 en attente`,
    detail: {
      kind: 't6_pregen_scheduler', cause: 'scheduler_inactive', task: PREGEN_TASK_CODE,
      accountsWaiting: comptes, accountIds: (r?.ids as number[] | null) ?? [], pendingRequests: demandes,
      adminDisabled: ordo.adminDisabled ?? null, envDisabled: ordo.envDisabled ?? null,
      lastFinishedAt: ordo.lastFinishedAt ?? null, lastSuccessAt: ordo.lastSuccessAt ?? null,
    },
  });
  out.schedulerReported = true;
}
