/**
 * T3 sur la file durable — CDC BO IA OPS-001, NFR-003, MOD-005, OPS-017,
 * VER-017, WF-06, WF-18, T3-003, T3-004.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE REMPLACE
 *
 * T3 avait deux chemins hors de `ai_job_queue` :
 *   · la réconciliation locale d'un bien, exécutée EN LIGNE par l'abonné à
 *     l'analyse T1 (`onSourceAnalyzed`) — perdue au moindre redémarrage ;
 *   · sa propre file (`account_reconciliation_runs` au statut `queued`),
 *     vidée par une route cron et planifiée par une variable d'environnement.
 * Ni l'une ni l'autre ne connaissait le backoff (MOD-005), l'échec définitif,
 * la relance manuelle, la remise en tête après rollback (WF-06) ni l'écran
 * File IA. Désactiver T3 laissait la file dédiée en l'état, sans visibilité.
 *
 * Désormais tout passe par `enqueue` ; le boucleur exécute. La table
 * `account_reconciliation_runs` reste le JOURNAL des exécutions T3 compte
 * (résultat consolidé, détail par objet) — elle n'est plus une file.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS FORMES DE TRAVAIL T3
 *
 *   · bien (`target_type = 'asset'`) : réconciliation locale après analyse T1,
 *     déclencheur `source_analyzed` ;
 *   · compte (`account_id`, sans cible) : contrôle global du compte, sur
 *     événement à impact de cohérence (temporisé et fusionné), planification
 *     ou lancement manuel ;
 *   · balayage (ni compte ni cible) : passage planifié, qui met en file un
 *     travail compte pour chaque compte à rationaliser (§15.1 : « le
 *     périmètre planifié est l'ensemble pertinent du traitement »).
 *
 * Pas de drapeau de bascule, à la différence de T1 : T3 n'est pas sur le
 * chemin d'un dépôt utilisateur, et le boucleur est démarré inconditionnel-
 * lement par `instrumentation.ts` (vérifié) — la durabilité est le défaut.
 */
import { randomUUID } from 'crypto';
import type { QueuedJob } from '../queue/job-queue.repository';
import type { ExecutionGuard } from '../queue/execution-control';
import type { T3Trigger } from './account-reconciliation.service';

/** Types de cible T3 dans la file. */
export const T3_TARGET_ASSET = 'asset';

/**
 * Événement métier → code du catalogue de déclencheurs (T3-005 : le catalogue
 * est défini dans le code). Un événement absent de cette table n'est pas un
 * événement à impact de cohérence : il ne déclenche rien (T3-004).
 */
export const T3_EVENT_TRIGGERS: Readonly<Record<string, string>> = {
  document_linked: 'document_linked',
  asset_updated: 'asset_updated',
  arbitration: 'arbitration_resolved',
  arbitration_resolved: 'arbitration_resolved',
};

/** Temporisation d'un contrôle compte après un événement (ancien `T3_EVENT_DEBOUNCE_MS`). */
export const T3_EVENT_DELAY_SECONDS = Math.round(Number(process.env.T3_EVENT_DEBOUNCE_MS ?? 10 * 60_000) / 1000);

export interface T3QueueDeps {
  enqueue: typeof import('../queue/job-queue.repository').enqueue;
  isTriggerActive: (treatment: 'T3', code: string) => Promise<boolean>;
}

async function defaultDeps(): Promise<T3QueueDeps> {
  const [{ enqueue }, { isTriggerActive }] = await Promise.all([
    import('../queue/job-queue.repository'),
    import('../queue/triggers'),
  ]);
  return { enqueue, isTriggerActive };
}

export interface CoherenceEvent {
  event: string;
  objectType?: T3Trigger['objectType'];
  objectId?: number;
  correlationId?: string;
}

/**
 * Demande un contrôle T3 du compte après un événement à impact de cohérence.
 *
 * Rend l'identifiant du job (créé ou absorbant), ou `null` si l'événement ne
 * déclenche rien : hors catalogue (T3-004) ou déclencheur inactif dans la
 * version effective. Les événements rapprochés d'un même compte fusionnent
 * dans le même job en attente (WF-10) ; leur trace s'accumule dans
 * `payload.events`, comme `events_json` le faisait.
 */
export async function enqueueT3ForEvent(
  accountId: number,
  e: CoherenceEvent,
  deps?: T3QueueDeps,
  now: Date = new Date(),
): Promise<number | null> {
  const code = T3_EVENT_TRIGGERS[e.event];
  if (!code) return null;
  const d = deps ?? await defaultDeps();
  if (!(await d.isTriggerActive('T3', code))) return null;

  const event = { ...e, correlationId: e.correlationId ?? randomUUID(), at: now.toISOString() };
  const { jobId } = await d.enqueue({
    treatment: 'T3',
    scope: { accountId },
    triggerCode: code,
    delaySeconds: T3_EVENT_DELAY_SECONDS,
    payload: { kind: 'account', scope: 'incremental', events: [event] },
    payloadOnDedupe: 'append_events',
  });
  return jobId;
}

/**
 * Réconciliation locale d'un bien après analyse T1 (déclencheur
 * `source_analyzed`). Remplace l'exécution en ligne de l'abonné.
 */
export async function enqueueT3ForAnalyzedAsset(
  input: { accountId: number; assetId: number; userId: number; leadSourceId: number },
  deps?: T3QueueDeps,
): Promise<number | null> {
  const d = deps ?? await defaultDeps();
  if (!(await d.isTriggerActive('T3', 'source_analyzed'))) return null;
  const { jobId } = await d.enqueue({
    treatment: 'T3',
    scope: { accountId: input.accountId, targetType: T3_TARGET_ASSET, targetId: input.assetId },
    triggerCode: 'source_analyzed',
    // Le document le plus récent l'emporte : c'est lui que la trace locale
    // doit citer comme source.
    payload: { kind: 'asset', userId: input.userId, sourceFileId: input.leadSourceId },
    payloadOnDedupe: 'replace',
  });
  return jobId;
}

/**
 * Lancement manuel d'un contrôle compte (WF-11, T3-011) : toujours une
 * nouvelle exécution, identifiable comme manuelle, sans déduplication.
 */
export async function enqueueT3Manual(
  accountId: number,
  adminUserId: number,
  scope: 'full' | 'incremental' = 'full',
  deps?: T3QueueDeps,
): Promise<number | null> {
  const d = deps ?? await defaultDeps();
  const { jobId } = await d.enqueue({
    treatment: 'T3',
    scope: { accountId },
    origin: 'manual',
    triggerCode: 'manual',
    payload: { kind: 'account', scope, requestedByUserId: adminUserId },
  });
  return jobId;
}

// ── Exécutant ───────────────────────────────────────────────────────────────

export interface T3HandlerDeps {
  reconcileAsset: (input: import('./reconciliation-engine').ReconcileInput) => Promise<unknown>;
  reconcileAccount: typeof import('./account-reconciliation.service').reconcileAccount;
  /** Comptes à rationaliser lors d'un balayage planifié. */
  listSweepAccounts: (periodHours: number) => Promise<number[]>;
  enqueue: typeof import('../queue/job-queue.repository').enqueue;
}

interface T3Payload {
  kind?: 'asset' | 'account';
  scope?: 'full' | 'incremental';
  userId?: number | null;
  sourceFileId?: number | null;
  requestedByUserId?: number | null;
  events?: Array<CoherenceEvent & { at?: string }>;
  triggerCode?: string;
}

/**
 * Exécute un travail T3. Pur vis-à-vis de la base : tout passe par `deps`,
 * ce qui permet de vérifier l'aiguillage sans rien démarrer.
 */
export async function runT3Job(job: QueuedJob, guard: ExecutionGuard, deps: T3HandlerDeps): Promise<void> {
  const p = (job.payload ?? {}) as T3Payload;

  // Balayage planifié : ni compte ni cible.
  if (job.accountId == null) {
    const { SCHEDULE_PERIOD_HOURS } = await import('../config/catalogs');
    const period = SCHEDULE_PERIOD_HOURS[job.triggerCode ?? ''] ?? 24;
    const comptes = await deps.listSweepAccounts(period);
    for (const accountId of comptes) {
      await guard.assertActive('mise en file planifiée');
      await deps.enqueue({
        treatment: 'T3',
        scope: { accountId },
        triggerCode: job.triggerCode ?? 'schedule_daily',
        payload: { kind: 'account', scope: 'incremental', scheduled: true },
      });
    }
    return;
  }

  // Bien : réconciliation locale post-analyse.
  if (job.targetType === T3_TARGET_ASSET && job.targetId) {
    const assetId = Number(job.targetId);
    if (!Number.isInteger(assetId) || !p.userId) {
      // Malformé : relancer ne l'améliorera pas (même règle que T1).
      console.error(`[t3-queue] travail ${job.id} sans bien ou utilisateur exploitable — ignoré.`);
      return;
    }
    await guard.assertActive('réconciliation du bien');
    await deps.reconcileAsset({
      accountId: job.accountId,
      userId: p.userId,
      assetId,
      triggeredBy: 'document_analyzed',
      sourceFileId: p.sourceFileId ?? undefined,
    });
    return;
  }

  // Compte : contrôle global.
  const last = p.events?.[p.events.length - 1];
  const trigger: T3Trigger = job.origin === 'manual'
    ? { type: 'manual', requestedByUserId: p.requestedByUserId ?? null }
    : (job.triggerCode ?? '').startsWith('schedule_') || (p as { scheduled?: boolean }).scheduled
      ? { type: 'scheduled' }
      : {
        type: 'event', event: last?.event, objectType: last?.objectType,
        objectId: last?.objectId, correlationId: last?.correlationId,
      };
  const scope = p.scope ?? (trigger.type === 'manual' ? 'full' : 'incremental');
  const result = await deps.reconcileAccount(job.accountId, trigger, { scope, guard, userId: p.requestedByUserId ?? undefined });

  if (result.status === 'skipped_concurrent') {
    // Une exécution compte est en cours hors file (route historique) : on
    // réessaie plus tard via le backoff, plutôt que de clore sans rien faire.
    throw new Error('exécution T3 déjà en cours sur ce compte — nouvelle tentative différée');
  }
  if (result.status === 'skipped_blocked') {
    // T3 coupé entre le prélèvement et le démarrage : interruption, pas
    // échec — le boucleur remet le job en tête sans consommer de tentative
    // (MOD-005, WF-07). Revue indépendante lot IA 2.
    const { ExecutionCancelledError } = await import('../queue/execution-control');
    throw new ExecutionCancelledError('T3 bloqué au démarrage (arrêt d\'urgence, désactivation ou suspension)');
  }
}

async function listSweepAccountsFromDb(periodHours: number): Promise<number[]> {
  const { pgClient } = await import('@/db');
  // Même périmètre que l'ancienne planification : comptes ayant des biens et
  // sans exécution T3 réussie ou en cours sur la période.
  const rows = (await pgClient.unsafe(
    `SELECT a.id FROM accounts a
      WHERE EXISTS (SELECT 1 FROM assets s WHERE s.account_id = a.id AND s.deleted_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM account_reconciliation_runs r
           WHERE r.account_id = a.id AND r.status IN ('completed', 'partial', 'running')
             AND coalesce(r.finished_at, r.started_at) > now() - ($1 || ' hours')::interval)
      ORDER BY a.id LIMIT 5000`,
    [String(periodHours)] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}

/**
 * Exécutant T3 branché sur la base — enregistré au démarrage par
 * `registerReconciliationHandlers` (reconciliation/index.ts), AVANT le
 * démarrage du boucleur dans `instrumentation.ts`.
 */
export async function t3JobHandler(job: QueuedJob, guard: ExecutionGuard): Promise<void> {
  const [{ reconcileAsset }, { reconcileAccount }, { enqueue }] = await Promise.all([
    import('./reconciliation-engine'),
    import('./account-reconciliation.service'),
    import('../queue/job-queue.repository'),
  ]);
  await runT3Job(job, guard, {
    reconcileAsset, reconcileAccount, enqueue, listSweepAccounts: listSweepAccountsFromDb,
  });
}
