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
import { isExecutionCancelled } from '../queue/execution-control';

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
  /** `skipped_blocked` : T3 désactivé, suspendu, ou arrêt d'urgence (OPS-008, OPS-011). */
  status: 'completed' | 'partial' | 'failed' | 'skipped_concurrent' | 'skipped_blocked';
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

/**
 * T3 peut-il démarrer une exécution ? (CDC BO IA OPS-008, OPS-011, WF-07, WF-08)
 *
 * Jusqu'ici, T3 ne lisait ni son état ni l'arrêt d'urgence : le bouton
 * « Désactiver T3 » était sans effet. Base illisible : on laisse passer — les
 * appels modèle restent de toute façon filtrés par la garde de la passerelle.
 */
async function t3PeutDemarrer(): Promise<boolean> {
  try {
    const { canStart } = await import('../queue/job-queue.repository');
    return await canStart('T3');
  } catch (e) {
    console.warn('[t3] état du traitement illisible, démarrage autorisé :', (e as Error).message);
    return true;
  }
}

export async function reconcileAccount(
  accountId: number,
  trigger: T3Trigger,
  options: {
    scope?: 'full' | 'incremental'; queuedRunId?: number; userId?: number;
    /** Garde d'exécution de la file (rollback, arrêt d'urgence, désactivation). */
    guard?: import('../queue/execution-control').ExecutionGuard;
  } = {},
  deps: AccountReconciliationDeps = defaultDeps,
): Promise<AccountRunResult> {
  const scope = options.scope ?? (trigger.type === 'manual' ? 'full' : 'incremental');
  const startedAt = new Date().toISOString();
  // Aucun démarrage si T3 est coupé : la demande en file (`queued`) n'est pas
  // réclamée, elle reste en attente et sera exécutée à la réactivation (WF-07).
  if (!(await t3PeutDemarrer())) {
    return {
      runId: 0, accountId, triggerType: trigger.type, scope, status: 'skipped_blocked', startedAt, finishedAt: startedAt,
      objectsExamined: 0, objectsModified: 0, decisionsApplied: 0, conflictsCreated: 0, arbitrationsNeeded: 0,
      errors: 0, aiCalls: 0, details: [],
    };
  }
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
      // Interrompue par l'administration (WF-06, WF-07) : aucun bien de plus
      // n'est réconcilié. L'erreur remonte au boucleur, qui ne clôt pas le job.
      if (options.guard) await options.guard.assertActive(`bien ${c.id}`);
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
        // Interruption (jeton révoqué, garde AI_BLOCKED) : on s'arrête là,
        // sans compter le bien en erreur ; le job est remis en file par le
        // boucleur (execution-control, MOD-005).
        if (isExecutionCancelled(e)) throw e;
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

// ── Déclenchement : file durable (CDC BO IA OPS-001, NFR-003, T3-003) ──────

/**
 * Délai laissé à la réconciliation locale post-T1 avant un contrôle global.
 * Appliqué par la file durable (`t3-queue.ts`, `delaySeconds`).
 */
export const EVENT_DEBOUNCE_MS = Number(process.env.T3_EVENT_DEBOUNCE_MS ?? 10 * 60_000);

/**
 * Demande une exécution T3 suite à un événement métier.
 *
 * Passe désormais par `ai_job_queue` (lot IA 2) : temporisation, fusion des
 * événements rapprochés d'un même compte (WF-10), backoff, relance, écran File
 * IA. Rend l'identifiant du job, ou `null` si l'événement ne déclenche rien
 * (hors catalogue, ou déclencheur inactif dans la version effective).
 */
export async function enqueueAccountReconciliation(
  accountId: number,
  event: { event: string; objectType?: T3Trigger['objectType']; objectId?: number; correlationId?: string },
  now: Date = new Date(),
): Promise<number | null> {
  const { enqueueT3ForEvent } = await import('./t3-queue');
  return enqueueT3ForEvent(accountId, event, undefined, now);
}

/** Non bloquant : un événement métier ne doit jamais échouer à cause de T3. */
export function notifyCoherenceEvent(
  accountId: number,
  event: { event: string; objectType?: T3Trigger['objectType']; objectId?: number },
): void {
  void enqueueAccountReconciliation(accountId, event).catch((e) =>
    console.error('[t3] demande de réconciliation non enregistrée :', (e as Error).message));
}

/**
 * Reprise des demandes de l'ancienne file T3 (`account_reconciliation_runs`
 * au statut `queued`) — transition.
 *
 * Plus rien n'y écrit ; les demandes restées en attente au déploiement sont
 * TRANSFÉRÉES dans la file durable (même temporisation résiduelle), puis la
 * ligne `queued` est supprimée : elle n'était qu'une demande, jamais une
 * exécution, et la garder ferait croire à un travail en attente.
 *
 * Conservé sous ce nom parce que la route cron l'appelle : il rend une liste
 * vide d'exécutions, puisque l'exécution appartient désormais au boucleur.
 */
export async function processDueAccountReconciliations(
  limit = 200,
): Promise<AccountRunResult[]> {
  const pending = (await pgClient.unsafe(
    `SELECT id, account_id, trigger_event, trigger_object_type, trigger_object_id, correlation_id,
            GREATEST(EXTRACT(EPOCH FROM (not_before - now())), 0)::int AS delay
       FROM account_reconciliation_runs
      WHERE status = 'queued'
      ORDER BY not_before LIMIT $1`,
    [limit] as never[],
  ).catch(() => [])) as unknown as Array<{ id: number; account_id: number; trigger_event: string | null; trigger_object_type: T3Trigger['objectType'] | null; trigger_object_id: number | null; correlation_id: string; delay: number }>;
  if (pending.length === 0) return [];
  const { enqueue } = await import('../queue/job-queue.repository');
  for (const q of pending) {
    try {
      await enqueue({
        treatment: 'T3',
        scope: { accountId: q.account_id },
        triggerCode: q.trigger_event ?? 'event',
        delaySeconds: q.delay,
        payload: {
          kind: 'account', scope: 'incremental',
          events: [{ event: q.trigger_event ?? 'event', objectType: q.trigger_object_type ?? undefined, objectId: q.trigger_object_id ?? undefined, correlationId: q.correlation_id }],
        },
        payloadOnDedupe: 'append_events',
      });
      await pgClient.unsafe(`DELETE FROM account_reconciliation_runs WHERE id = $1 AND status = 'queued'`, [q.id] as never[]);
    } catch (e) {
      // SCR-08 : la ligne n'est supprimée qu'une fois le transfert acquitté.
      console.error(`[t3] transfert de la demande ${q.id} impossible :`, (e as Error).message);
    }
  }
  console.info(`[t3] ${pending.length} demande(s) de l'ancienne file transférée(s) dans la file durable.`);
  return [];
}

/**
 * Ancienne planification par variable d'environnement — RETIRÉE (T3-006,
 * T3-UI-05). La planification T3 est désormais portée par les déclencheurs
 * `schedule_*` de la version effective, mis en file par le boucleur
 * (`queue/triggers.ts`) ; sans version renseignée, le défaut du code est
 * quotidien, comme l'ancienne valeur par défaut de 24 h.
 *
 * Rend une liste vide : la route cron qui l'appelle reste compatible, et deux
 * planificateurs ne tournent jamais ensemble.
 */
export async function runScheduledAccountReconciliations(): Promise<AccountRunResult[]> {
  return [];
}
