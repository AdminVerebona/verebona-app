/**
 * T3 — réconciliation globale au niveau du COMPTE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T1 produit les preuves ; T3 exploite les preuves existantes pour contrôler
 * la cohérence globale.
 *
 * Jusqu'ici, le moteur ne tournait que bien par bien, juste après une
 * analyse T1 (`reconcileAsset` sur le bien du document). Rien ne contrôlait
 * la cohérence d'un compte indépendamment du dernier document traité.
 *
 * `reconcileAccount` est un ORCHESTRATEUR, pas un second moteur :
 *   · il sélectionne le périmètre (tous les biens éligibles, ou un périmètre
 *     incrémental) ;
 *   · il exécute pour chacun le moteur commun (`reconcileAsset` : matrice
 *     d'autorité, normalisation, décision, conflits, protection des valeurs
 *     utilisateur, résolution IA éventuelle, pont « À traiter ») ;
 *   · il consolide les résultats, objet par objet, sans qu'une erreur sur un
 *     bien n'interrompe les autres ;
 *   · il trace une exécution globale, à laquelle chaque run local est
 *     rattaché (reconciliation_runs.account_run_id).
 *
 * Il ne relit AUCUN fichier et ne relance aucune extraction : s'il manque une
 * preuve, le moteur le constate.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'crypto';
import { pgClient } from '@/db';
import type { ReconcileInput } from './reconciliation-engine';
import type { ReconciliationRun } from './types';

export type T3TriggerType = 'manual' | 'scheduled' | 'event';

export interface T3Trigger {
  type: T3TriggerType;
  /** Événement métier (event) : document_linked, document_unlinked, arbitration, asset_updated… */
  event?: string;
  objectType?: 'asset' | 'document' | 'equipment' | 'to_process_action';
  objectId?: number;
  correlationId?: string;
  requestedByUserId?: number | null;
}

export type ObjectOutcome = 'SUCCESS' | 'CONFLICT' | 'ERROR' | 'SKIPPED';

export interface ObjectResult {
  objectType: 'asset';
  objectId: number;
  status: ObjectOutcome;
  localRunId?: number;
  applied: number;
  conflicts: number;
  aiReviews: number;
  reason?: string;
}

export interface AccountRunResult {
  runId: number;
  accountId: number;
  triggerType: T3TriggerType;
  scope: 'full' | 'incremental';
  status: 'completed' | 'partial' | 'failed' | 'skipped_concurrent';
  startedAt: string;
  finishedAt: string;
  objectsExamined: number;
  objectsModified: number;
  decisionsApplied: number;
  conflictsCreated: number;
  arbitrationsNeeded: number;
  errors: number;
  aiCalls: number;
  details: ObjectResult[];
}

/** Au-delà, un run « en cours » est réputé abandonné (processus arrêté). */
export const STALE_RUN_MINUTES = 30;

/** Correspondance déclencheur T3 → origine tracée du run local. */
const LOCAL_TRIGGER: Record<T3TriggerType, ReconcileInput['triggeredBy']> = {
  manual: 'manual',
  scheduled: 'scheduled',
  event: 'field_changed',
};

export interface AccountReconciliationDeps {
  reconcile(input: ReconcileInput): Promise<ReconciliationRun>;
}

const defaultDeps: AccountReconciliationDeps = {
  async reconcile(input) {
    const { reconcileAsset } = await import('./reconciliation-engine');
    return reconcileAsset(input);
  },
};

/** Consolidation — pure, testée sans base. */
export function consolidate(details: ObjectResult[]): Pick<AccountRunResult,
  'objectsExamined' | 'objectsModified' | 'decisionsApplied' | 'conflictsCreated' | 'arbitrationsNeeded' | 'errors' | 'aiCalls' | 'status'> {
  const examined = details.filter((d) => d.status !== 'SKIPPED');
  const errors = details.filter((d) => d.status === 'ERROR').length;
  return {
    objectsExamined: examined.length,
    objectsModified: details.filter((d) => d.applied > 0).length,
    decisionsApplied: details.reduce((n, d) => n + d.applied, 0),
    conflictsCreated: details.reduce((n, d) => n + d.conflicts, 0),
    arbitrationsNeeded: details.filter((d) => d.conflicts > 0).length,
    errors,
    aiCalls: details.reduce((n, d) => n + d.aiReviews, 0),
    status: errors === 0 ? 'completed' : errors < examined.length ? 'partial' : 'failed',
  };
}

// ── Périmètre ──────────────────────────────────────────────────────────────

interface Candidate { id: number; eligible: boolean; reason?: string }

/**
 * Objets à examiner. `full` : tous les biens du compte. `incremental` :
 * biens modifiés depuis la dernière exécution T3 réussie, biens ayant reçu
 * une preuve depuis, biens portant un conflit ouvert, et l'objet déclencheur.
 * L'incrémental est une STRATÉGIE : sans exécution de référence, tout est
 * examiné.
 */
async function selectScope(accountId: number, scope: 'full' | 'incremental', trigger: T3Trigger): Promise<Candidate[]> {
  const all = (await pgClient.unsafe(
    `SELECT id, coalesce(status, 'EN_SERVICE') AS status, updated_at
       FROM assets WHERE account_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [accountId] as never[],
  )) as unknown as Array<{ id: number; status: string; updated_at: Date | null }>;

  let retenus = new Set(all.map((a) => a.id));
  if (scope === 'incremental') {
    const [last] = (await pgClient.unsafe(
      `SELECT max(finished_at) AS at FROM account_reconciliation_runs
        WHERE account_id = $1 AND status IN ('completed', 'partial')`,
      [accountId] as never[],
    )) as unknown as Array<{ at: Date | null }>;
    if (last?.at) {
      const since = new Date(last.at).toISOString();
      const touches = (await pgClient.unsafe(
        `SELECT DISTINCT id FROM (
           SELECT a.id FROM assets a WHERE a.account_id = $1 AND a.updated_at > $2::timestamptz
           UNION SELECT fe.asset_id FROM field_evidence fe WHERE fe.account_id = $1 AND fe.extracted_at > $2::timestamptz
           UNION SELECT c.asset_id FROM inconsistency_registry c WHERE c.account_id = $1 AND c.status = 'open'
         ) s WHERE id IS NOT NULL`,
        [accountId, since] as never[],
      ).catch(() => all.map((a) => ({ id: a.id })))) as unknown as Array<{ id: number }>;
      retenus = new Set(touches.map((t) => t.id));
      if (trigger.objectType === 'asset' && trigger.objectId) retenus.add(trigger.objectId);
    }
  }

  return all
    .filter((a) => retenus.has(a.id))
    .map((a) => ['ARCHIVED', 'TRANSMIS'].includes(a.status)
      ? { id: a.id, eligible: false, reason: `bien ${a.status.toLowerCase()}` }
      : { id: a.id, eligible: true });
}

// ── Exécution ──────────────────────────────────────────────────────────────

/**
 * Prend l'exécution du compte : au plus une en cours. Une exécution restée
 * « running » au-delà de STALE_RUN_MINUTES est close en échec (processus
 * arrêté) avant une nouvelle tentative.
 */
async function claim(accountId: number, trigger: T3Trigger, scope: 'full' | 'incremental', queuedId?: number): Promise<number | null> {
  await pgClient.unsafe(
    `UPDATE account_reconciliation_runs SET status = 'failed', finished_at = now()
      WHERE account_id = $1 AND status = 'running' AND started_at < now() - ($2 || ' minutes')::interval`,
    [accountId, String(STALE_RUN_MINUTES)] as never[],
  );
  try {
    if (queuedId) {
      const rows = (await pgClient.unsafe(
        `UPDATE account_reconciliation_runs SET status = 'running', started_at = now()
          WHERE id = $1 AND status = 'queued' RETURNING id`,
        [queuedId] as never[],
      )) as unknown as Array<{ id: number }>;
      return rows[0]?.id ?? null;
    }
    const rows = (await pgClient.unsafe(
      `INSERT INTO account_reconciliation_runs
         (account_id, trigger_type, trigger_event, trigger_object_type, trigger_object_id, correlation_id,
          requested_by_user_id, scope, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running', now()) RETURNING id`,
      [accountId, trigger.type, trigger.event ?? null, trigger.objectType ?? null, trigger.objectId ?? null,
       trigger.correlationId ?? randomUUID(), trigger.requestedByUserId ?? null, scope] as never[],
    )) as unknown as Array<{ id: number }>;
    return rows[0]?.id ?? null;
  } catch (e) {
    // Violation de l'unicité « une exécution en cours par compte ».
    if (/account_reconciliation_runs_one_running|duplicate key/.test((e as Error).message)) return null;
    throw e;
  }
}

export async function reconcileAccount(
  accountId: number,
  trigger: T3Trigger,
  options: { scope?: 'full' | 'incremental'; queuedRunId?: number; userId?: number } = {},
  deps: AccountReconciliationDeps = defaultDeps,
): Promise<AccountRunResult> {
  const scope = options.scope ?? (trigger.type === 'manual' ? 'full' : 'incremental');
  const startedAt = new Date().toISOString();
  const runId = await claim(accountId, trigger, scope, options.queuedRunId);
  if (!runId) {
    return {
      runId: 0, accountId, triggerType: trigger.type, scope, status: 'skipped_concurrent', startedAt, finishedAt: startedAt,
      objectsExamined: 0, objectsModified: 0, decisionsApplied: 0, conflictsCreated: 0, arbitrationsNeeded: 0,
      errors: 0, aiCalls: 0, details: [],
    };
  }

  const details: ObjectResult[] = [];
  try {
    const candidates = await selectScope(accountId, scope, trigger);
    for (const c of candidates) {
      if (!c.eligible) {
        details.push({ objectType: 'asset', objectId: c.id, status: 'SKIPPED', applied: 0, conflicts: 0, aiReviews: 0, reason: c.reason });
        continue;
      }
      try {
        const run = await deps.reconcile({
          accountId, assetId: c.id, userId: options.userId ?? trigger.requestedByUserId ?? undefined,
          triggeredBy: LOCAL_TRIGGER[trigger.type], accountRunId: runId,
        });
        details.push({
          objectType: 'asset', objectId: c.id, localRunId: run.runId,
          status: run.conflictCount > 0 ? 'CONFLICT' : 'SUCCESS',
          applied: run.appliedCount, conflicts: run.conflictCount, aiReviews: run.aiReviewCount,
        });
      } catch (e) {
        // L'échec d'un bien n'empêche pas les autres d'être traités.
        details.push({ objectType: 'asset', objectId: c.id, status: 'ERROR', applied: 0, conflicts: 0, aiReviews: 0, reason: (e as Error).message.slice(0, 300) });
      }
    }
  } finally {
    const totals = consolidate(details);
    await pgClient.unsafe(
      `UPDATE account_reconciliation_runs SET
         status = $2, finished_at = now(), objects_examined = $3, objects_modified = $4,
         decisions_applied = $5, conflicts_created = $6, arbitrations_needed = $7, errors = $8,
         ai_calls = $9, details_json = $10::jsonb
       WHERE id = $1`,
      [runId, details.length === 0 ? 'completed' : totals.status, totals.objectsExamined, totals.objectsModified,
       totals.decisionsApplied, totals.conflictsCreated, totals.arbitrationsNeeded, totals.errors,
       totals.aiCalls, JSON.stringify(details)] as never[],
    );
  }

  const totals = consolidate(details);
  return {
    runId, accountId, triggerType: trigger.type, scope, startedAt, finishedAt: new Date().toISOString(),
    details, ...totals, status: details.length === 0 ? 'completed' : totals.status,
  };
}

// ── Déclenchement événementiel : temporisation et fusion ───────────────────

/** Délai laissé à la réconciliation locale post-T1 avant un contrôle global. */
export const EVENT_DEBOUNCE_MS = Number(process.env.T3_EVENT_DEBOUNCE_MS ?? 10 * 60_000);

/**
 * Demande une exécution T3 suite à un événement métier. Les événements
 * rapprochés d'un même compte FUSIONNENT dans une seule demande en attente
 * (index unique « une demande en attente par compte ») ; l'exécution a lieu
 * après `EVENT_DEBOUNCE_MS`, ce qui évite de doubler la réconciliation
 * locale qui suit immédiatement une analyse T1.
 */
export async function enqueueAccountReconciliation(
  accountId: number,
  event: { event: string; objectType?: T3Trigger['objectType']; objectId?: number; correlationId?: string },
  now: Date = new Date(),
): Promise<number> {
  const trace = JSON.stringify([{ ...event, at: now.toISOString() }]);
  const notBefore = new Date(now.getTime() + EVENT_DEBOUNCE_MS).toISOString();
  const rows = (await pgClient.unsafe(
    `INSERT INTO account_reconciliation_runs
       (account_id, trigger_type, trigger_event, trigger_object_type, trigger_object_id, correlation_id, scope, status, not_before, events_json)
     VALUES ($1, 'event', $2, $3, $4, $5, 'incremental', 'queued', $6, $7::jsonb)
     ON CONFLICT (account_id) WHERE status = 'queued'
     DO UPDATE SET events_json = account_reconciliation_runs.events_json || EXCLUDED.events_json
     RETURNING id`,
    [accountId, event.event, event.objectType ?? null, event.objectId ?? null, event.correlationId ?? randomUUID(), notBefore, trace] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows[0].id;
}

/** Non bloquant : un événement métier ne doit jamais échouer à cause de T3. */
export function notifyCoherenceEvent(
  accountId: number,
  event: { event: string; objectType?: T3Trigger['objectType']; objectId?: number },
): void {
  void enqueueAccountReconciliation(accountId, event).catch((e) =>
    console.error('[t3] demande de réconciliation non enregistrée :', (e as Error).message));
}

/** Exécute les demandes événementielles arrivées à échéance. */
export async function processDueAccountReconciliations(
  limit = 20,
  deps: AccountReconciliationDeps = defaultDeps,
): Promise<AccountRunResult[]> {
  const due = (await pgClient.unsafe(
    `SELECT id, account_id, trigger_event, trigger_object_type, trigger_object_id, correlation_id
       FROM account_reconciliation_runs
      WHERE status = 'queued' AND not_before <= now()
      ORDER BY not_before LIMIT $1`,
    [limit] as never[],
  )) as unknown as Array<{ id: number; account_id: number; trigger_event: string | null; trigger_object_type: T3Trigger['objectType'] | null; trigger_object_id: number | null; correlation_id: string }>;
  const out: AccountRunResult[] = [];
  for (const q of due) {
    out.push(await reconcileAccount(q.account_id, {
      type: 'event', event: q.trigger_event ?? undefined, objectType: q.trigger_object_type ?? undefined,
      objectId: q.trigger_object_id ?? undefined, correlationId: q.correlation_id,
    }, { scope: 'incremental', queuedRunId: q.id }, deps));
  }
  return out;
}

/** Fréquence de l'exécution planifiée (heures), modifiable par l'environnement. */
export const SCHEDULE_INTERVAL_HOURS = Number(process.env.T3_ACCOUNT_RECONCILIATION_INTERVAL_HOURS ?? 24);

/**
 * Exécution planifiée : rejoue la cohérence des comptes dont la dernière
 * exécution T3 date de plus de SCHEDULE_INTERVAL_HOURS — à partir des
 * connaissances persistées, jamais par réanalyse des documents.
 */
export async function runScheduledAccountReconciliations(
  limit = 50,
  deps: AccountReconciliationDeps = defaultDeps,
): Promise<AccountRunResult[]> {
  const comptes = (await pgClient.unsafe(
    `SELECT a.id FROM accounts a
      WHERE EXISTS (SELECT 1 FROM assets s WHERE s.account_id = a.id AND s.deleted_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM account_reconciliation_runs r
           WHERE r.account_id = a.id AND r.status IN ('completed', 'partial', 'running')
             AND coalesce(r.finished_at, r.started_at) > now() - ($1 || ' hours')::interval)
      ORDER BY a.id LIMIT $2`,
    [String(SCHEDULE_INTERVAL_HOURS), limit] as never[],
  )) as unknown as Array<{ id: number }>;
  const out: AccountRunResult[] = [];
  for (const c of comptes) out.push(await reconcileAccount(c.id, { type: 'scheduled' }, { scope: 'incremental' }, deps));
  return out;
}
