/**
 * T3 sur la file durable — CDC BO IA OPS-001, NFR-003, MOD-005, OPS-017,
 * VER-017, WF-06, WF-18, T3-003, T3-004 ; contrat formalisé au lot 31C.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE REMPLACE
 *
 * T3 avait deux chemins hors de `ai_job_queue` :
 *   · la réconciliation locale d'un bien, exécutée EN LIGNE par l'abonné à
 *     l'analyse T1 (`onSourceAnalyzed`) — perdue au moindre redémarrage ;
 *   · sa propre file (`account_reconciliation_runs` au statut `queued`),
 *     vidée par une route cron et planifiée par une variable d'environnement.
 *
 * Désormais tout passe par `enqueue` ; le boucleur exécute. La table
 * `account_reconciliation_runs` reste le JOURNAL des exécutions T3 compte
 * (résultat consolidé, détail par objet) — elle n'est plus une file.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FORMES DE TRAVAIL T3 (contrat : `t3-job-contract.ts`, `payloadVersion: 1`)
 *
 *   · bien (`target_type = 'asset'`, kind `asset`) ;
 *   · équipement / pièce (`target_type = 'equipment' | 'room'`, kind `entity`) ;
 *   · compte (`account_id`, sans cible, kind `account`, scope incremental|full) ;
 *   · balayage planifié (ni compte ni cible, kind `sweep`) et ses pages de
 *     continuation (`target_type = 't3_sweep'`) : un fan-out BORNÉ de travaux
 *     compte par page, curseur stable sur l'identifiant de compte.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCLENCHEUR RÉEL (lot 31C)
 *
 *   analyse de source                       → source_analyzed
 *   rattachement / détachement / déplacement
 *   / suppression d'un document             → document_linked
 *   modification d'un bien                  → asset_updated
 *   résolution d'un À traiter               → arbitration_resolved
 *   planification                           → schedule_hourly (défaut nominal)
 *   lancement administrateur                → manual (origin = manual)
 *
 * Le déclencheur contrôlé (`isTriggerActive`) est celui qui est écrit sur le
 * job : `source_analyzed` désactivé n'empêche plus les réconciliations
 * provoquées par un changement de rattachement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ISSUE D'UN TRAVAIL
 *
 *   inexécutable (contexte, cible, version)   → PermanentJobError → FAILED immédiat
 *   erreur technique                          → retry + backoff, FAILED à la 5e exécution
 *   interruption d'exploitation               → PENDING en tête, tentative rendue
 *   exécuté                                   → DONE + résultat métier :
 *        APPLIED | NO_CHANGE | ABSTAIN | SUPERSEDED | TARGET_GONE
 *
 * Avant toute écriture métier, l'exécution relit l'état canonique (cible
 * toujours présente ? travail rendu obsolète par une exécution plus récente ?)
 * puis appelle `guard.assertActive()` ; le moteur fait de même avant chaque
 * écriture (`assertJobActive`).
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { randomUUID } from 'crypto';
import type { QueuedJob } from '../queue/job-queue.repository';
import { isExecutionCancelled, type ExecutionGuard } from '../queue/execution-control';
import { PermanentJobError, JobDeferredError, type JobBusinessResult } from '../queue/queue-policy';
import type { T3Trigger } from './account-reconciliation.service';
import type { ReconciliationDecision } from './types';
import { envNumber } from '@/lib/env-number';
import {
  buildT3Payload, resolveT3Job,
  T3_TARGET_ASSET, T3_TARGET_EQUIPMENT, T3_TARGET_ROOM, T3_TARGET_SWEEP_PAGE,
  type T3AccountPayload, type T3AssetPayload, type T3EntityPayload, type T3SweepPayload,
} from './t3-job-contract';

export {
  T3_TARGET_ASSET, T3_TARGET_EQUIPMENT, T3_TARGET_ROOM, T3_TARGET_SWEEP_PAGE, T3_PAYLOAD_VERSION,
  registerT3JobKind, buildT3Payload,
} from './t3-job-contract';

const CIBLE_FILE: Record<'EQUIPMENT' | 'ROOM', string> = { EQUIPMENT: T3_TARGET_EQUIPMENT, ROOM: T3_TARGET_ROOM };

/**
 * Événement métier → code du catalogue de déclencheurs (T3-005 : le catalogue
 * est défini dans le code). Un événement absent de cette table n'est pas un
 * événement à impact de cohérence : il ne déclenche rien (T3-004).
 */
export const T3_EVENT_TRIGGERS: Readonly<Record<string, string>> = {
  document_linked: 'document_linked',
  document_unlinked: 'document_linked',
  asset_updated: 'asset_updated',
  arbitration: 'arbitration_resolved',
  arbitration_resolved: 'arbitration_resolved',
  // Lot 34E (réconciliation continue) — codes du catalogue ACTUEL : un
  // équipement / une pièce créé ou modifié, une connaissance consolidée.
  entity_updated: 'asset_updated',
  knowledge_updated: 'document_linked',
};

/** Temporisation d'un contrôle compte après un événement (ancien `T3_EVENT_DEBOUNCE_MS`). */
export const T3_EVENT_DELAY_SECONDS = Math.round(envNumber('T3_EVENT_DEBOUNCE_MS', 10 * 60_000, { min: 0 }) / 1000);

/** Balayage : comptes mis en file par page (`T3_SWEEP_PAGE_SIZE`, 50 par défaut, 1 à 1000). */
export function sweepPageSize(): number {
  return Math.min(1000, Math.floor(envNumber('T3_SWEEP_PAGE_SIZE', 50, { min: 1 })));
}
/** Délai avant la page suivante (`T3_SWEEP_PAGE_DELAY_SECONDS`, 60 s par défaut). */
export function sweepPageDelaySeconds(): number {
  return Math.floor(envNumber('T3_SWEEP_PAGE_DELAY_SECONDS', 60, { min: 0 }));
}
/**
 * Délai quand les travaux planifiés de la page précédente attendent encore
 * (`T3_SWEEP_BACKLOG_DELAY_SECONDS`, 300 s par défaut) : la page ne met rien
 * en file et se reporte — la file n'est jamais remplie d'un coup.
 */
export function sweepBacklogDelaySeconds(): number {
  return Math.floor(envNumber('T3_SWEEP_BACKLOG_DELAY_SECONDS', 300, { min: 0 }));
}

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
 * `payload.events`, bornée à `MAX_MERGED_EVENTS`.
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
    payload: buildT3Payload('account', { scope: 'incremental', events: [event] }, now),
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
    payload: buildT3Payload('asset', { userId: input.userId, sourceFileId: input.leadSourceId, triggeredBy: 'document_analyzed' }),
    payloadOnDedupe: 'replace',
  });
  return jobId;
}

/** Déclencheurs qu'un travail ciblé « cycle de vie » peut porter. */
export type T3LifecycleTrigger = 'document_linked' | 'source_analyzed';

/**
 * Réconciliation des biens touchés par une transition du cycle de vie d'un
 * document (CDC 15 T3-03 : rattachement, détachement, déplacement,
 * suppression avec retrait des preuves).
 *
 * Lot 31C : déclencheur RÉEL `document_linked` — écrit sur le job ET contrôlé
 * (`isTriggerActive`). L'ancien contrat (`triggerCode = source_analyzed`,
 * `payload.triggeredBy = document_linked`) coupait ces réconciliations dès
 * que `source_analyzed` était désactivé. `triggerCode: 'source_analyzed'`
 * reste possible pour les appelants dont la cause est une (ré)analyse de
 * source (révision de date T4, revalidation de fait T2) : comportement
 * inchangé pour eux.
 */
export async function enqueueT3ForAssets(
  input: {
    accountId: number; userId: number; assetIds: number[]; sourceFileId?: number | null; reason: string;
    triggerCode?: T3LifecycleTrigger;
  },
  deps?: T3QueueDeps,
): Promise<number[]> {
  const ids = [...new Set(input.assetIds.filter((a) => Number.isInteger(a) && a > 0))];
  if (ids.length === 0) return [];
  const code: T3LifecycleTrigger = input.triggerCode ?? 'document_linked';
  const d = deps ?? await defaultDeps();
  if (!(await d.isTriggerActive('T3', code))) return [];
  const jobs: number[] = [];
  for (const assetId of ids) {
    const { jobId } = await d.enqueue({
      treatment: 'T3',
      scope: { accountId: input.accountId, targetType: T3_TARGET_ASSET, targetId: assetId },
      triggerCode: code,
      payload: buildT3Payload('asset', {
        userId: input.userId, sourceFileId: input.sourceFileId ?? null,
        // Trace du run local (et réconciliation de statut agenda) : le
        // cycle de vie d'un document, quelle que soit la cause.
        triggeredBy: 'document_linked', lifecycleReason: input.reason,
      }),
      payloadOnDedupe: 'replace',
    });
    if (jobId != null) jobs.push(jobId);
  }
  return jobs;
}

/**
 * Réconciliation ciblée d'équipements ou de pièces (lot 18, R3) : après
 * l'analyse d'un document qui a écrit des preuves sur ces cibles
 * (`source_analyzed`), ou après le retrait de leurs preuves par le cycle de
 * vie d'un document (`document_linked`, lot 31C).
 */
export async function enqueueT3ForEntities(
  input: {
    accountId: number; userId: number; targets: Array<{ type: 'EQUIPMENT' | 'ROOM'; id: number }>;
    sourceFileId?: number | null; triggeredBy?: 'document_analyzed' | 'document_linked'; reason?: string;
  },
  deps?: T3QueueDeps,
): Promise<number[]> {
  const vus = new Set<string>();
  const cibles = input.targets.filter((t) => {
    const k = `${t.type}:${t.id}`;
    if (!CIBLE_FILE[t.type] || !Number.isInteger(t.id) || t.id <= 0 || vus.has(k)) return false;
    vus.add(k);
    return true;
  });
  if (cibles.length === 0) return [];
  const triggeredBy = input.triggeredBy ?? 'document_analyzed';
  const code: T3LifecycleTrigger = triggeredBy === 'document_linked' ? 'document_linked' : 'source_analyzed';
  const d = deps ?? await defaultDeps();
  if (!(await d.isTriggerActive('T3', code))) return [];
  const jobs: number[] = [];
  for (const t of cibles) {
    const { jobId } = await d.enqueue({
      treatment: 'T3',
      scope: { accountId: input.accountId, targetType: CIBLE_FILE[t.type], targetId: t.id },
      triggerCode: code,
      payload: buildT3Payload('entity', {
        userId: input.userId, sourceFileId: input.sourceFileId ?? null,
        triggeredBy, lifecycleReason: input.reason ?? null,
      }),
      payloadOnDedupe: 'replace',
    });
    if (jobId != null) jobs.push(jobId);
  }
  return jobs;
}

/**
 * Lancement manuel d'un contrôle compte (WF-11, T3-011) : toujours une
 * nouvelle exécution, identifiable comme manuelle, jamais absorbée par un
 * travail automatique vivant (sans priorité de file pour autant).
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
    payload: buildT3Payload('account', { scope, requestedByUserId: adminUserId }),
  });
  return jobId;
}

// ── Exécutant ───────────────────────────────────────────────────────────────

/** Page de balayage : comptes à rationaliser, après le curseur. */
export interface SweepAccountsQuery {
  /** Comptes sans exécution T3 réussie ou en cours depuis cette date. */
  since: Date;
  /** Curseur stable : identifiants strictement supérieurs. */
  afterAccountId: number;
  limit: number;
}

export interface T3HandlerDeps {
  reconcileAsset: (input: import('./reconciliation-engine').ReconcileInput) => Promise<unknown>;
  /** Équipement / pièce (lot 18). */
  reconcileEntity?: (input: import('./entity-reconciliation').ReconcileEntityInput) => Promise<unknown>;
  reconcileAccount: typeof import('./account-reconciliation.service').reconcileAccount;
  /** Comptes à rationaliser lors d'un balayage planifié, par page (curseur stable). */
  listSweepAccounts: (q: SweepAccountsQuery) => Promise<number[]>;
  enqueue: typeof import('../queue/job-queue.repository').enqueue;
  // ── Relecture de l'état canonique (lot 31C). Absentes : contrôle omis. ──
  /** Le bien existe-t-il encore, non supprimé, dans ce compte ? */
  assetExists?: (accountId: number, assetId: number) => Promise<boolean>;
  /** Une réconciliation locale réussie du bien a-t-elle démarré après `since` ? */
  assetReconciledSince?: (accountId: number, assetId: number, since: Date) => Promise<boolean>;
  /**
   * Une exécution T3 compte réussie a-t-elle démarré après `since` ?
   * `fullOnly` : seule une exécution `full` couvre un travail événementiel.
   */
  accountReconciledSince?: (accountId: number, since: Date, fullOnly: boolean) => Promise<boolean>;
  /** Pages de balayage vivantes (cycle en cours). */
  liveSweepPages?: () => Promise<number>;
  /** Travaux compte planifiés encore en attente (charge laissée par les pages précédentes). */
  sweepBacklog?: () => Promise<number>;
}

const latest = (...dates: Array<string | Date | null | undefined>): Date => {
  let best = 0;
  for (const d of dates) {
    const t = d ? new Date(d).getTime() : NaN;
    if (Number.isFinite(t) && t > best) best = t;
  }
  return new Date(best);
};

const decisionsDe = (run: unknown): ReconciliationDecision[] => {
  const d = (run as { decisions?: unknown } | null)?.decisions;
  return Array.isArray(d) ? d as ReconciliationDecision[] : [];
};

/** Résultat métier d'une réconciliation (bien ou entité) — pur. */
export function reconciliationBusinessResult(decisions: ReconciliationDecision[], written?: number | null): JobBusinessResult {
  // Lot 58C : APPLIED = écritures CONFIRMÉES quand elles sont connues ; les
  // intentions (apply / update) ne comptent que pour un appelant historique.
  const intended = decisions.filter((x) => x.action === 'apply' || x.action === 'update').length;
  const applied = written ?? intended;
  const conflicts = decisions.filter((x) => x.action === 'create_conflict').length;
  const detail = { decisions: decisions.length, applied, conflicts, ...(written != null && intended !== applied ? { intended } : {}) };
  if (applied > 0) return { result: 'APPLIED', detail };
  if (conflicts > 0) return { result: 'ABSTAIN', detail };
  return { result: 'NO_CHANGE', detail };
}

/**
 * Exécute un travail T3. Pur vis-à-vis de la base : tout passe par `deps`,
 * ce qui permet de vérifier l'aiguillage sans rien démarrer.
 *
 * Lève `PermanentJobError` pour un travail inexécutable ; rend le résultat
 * métier sinon (DONE).
 */
export async function runT3Job(job: QueuedJob, guard: ExecutionGuard, deps: T3HandlerDeps): Promise<JobBusinessResult> {
  const r = resolveT3Job(job);
  if (r.spec.run) return r.spec.run({ job, payload: r.payload, guard });
  switch (r.kind) {
    case 'sweep': return runSweep(job, r.payload as T3SweepPayload, guard, deps);
    case 'asset': return runAsset(job, r.payload as T3AssetPayload, guard, deps);
    case 'entity': return runEntity(job, r.payload as T3EntityPayload, guard, deps);
    case 'account': return runAccount(job, r.payload as T3AccountPayload, guard, deps);
    default: throw new PermanentJobError(`T3 job ${job.id} : sorte « ${r.kind} » sans exécutant`);
  }
}

async function runAsset(job: QueuedJob, p: T3AssetPayload, guard: ExecutionGuard, deps: T3HandlerDeps): Promise<JobBusinessResult> {
  const accountId = job.accountId as number;
  // Relecture de l'état canonique : la cible a pu disparaître depuis la mise en file.
  if (deps.assetExists && !(await deps.assetExists(accountId, p.assetId))) {
    return { result: 'TARGET_GONE', detail: { assetId: p.assetId } };
  }
  // Une réconciliation complète du bien, démarrée APRÈS la demande, a déjà
  // relu toutes ses preuves. Seulement sans source : la réconciliation de
  // statut agenda d'une source (T4-12) n'est faite que par CE travail.
  if (p.sourceFileId == null && deps.assetReconciledSince
    && await deps.assetReconciledSince(accountId, p.assetId, latest(job.createdAt, p.requestedAt))) {
    return { result: 'SUPERSEDED', detail: { assetId: p.assetId } };
  }
  await guard.assertActive('réconciliation du bien');
  const run = await deps.reconcileAsset({
    accountId, userId: p.userId, assetId: p.assetId, triggeredBy: p.triggeredBy,
    sourceFileId: p.sourceFileId ?? undefined,
  });
  const confirmees = (run as { appliedCount?: unknown } | null)?.appliedCount;
  const res = reconciliationBusinessResult(decisionsDe(run), typeof confirmees === 'number' ? confirmees : null);
  return { ...res, detail: { ...res.detail, assetId: p.assetId, runId: (run as { runId?: number } | null)?.runId ?? null } };
}

async function runEntity(job: QueuedJob, p: T3EntityPayload, guard: ExecutionGuard, deps: T3HandlerDeps): Promise<JobBusinessResult> {
  if (!deps.reconcileEntity) {
    throw new PermanentJobError(`T3 job ${job.id} : cible ${job.targetType} sans exécutant de réconciliation d'entité`);
  }
  await guard.assertActive('réconciliation de la cible');
  const out = await deps.reconcileEntity({
    accountId: job.accountId as number, target: p.target, userId: p.userId,
    sourceFileId: p.sourceFileId, triggeredBy: p.triggeredBy,
  }) as { skipped?: boolean; written?: string[]; retracted?: string[]; decisions?: ReconciliationDecision[] } | null;
  // Entité introuvable ou archivée à l'exécution (état canonique relu).
  if (out?.skipped) return { result: 'TARGET_GONE', detail: { target: p.target } };
  const res = reconciliationBusinessResult(decisionsDe(out), (out?.written?.length ?? 0) + (out?.retracted?.length ?? 0));
  return { ...res, detail: { ...res.detail, target: p.target } };
}

async function runAccount(job: QueuedJob, p: T3AccountPayload, guard: ExecutionGuard, deps: T3HandlerDeps): Promise<JobBusinessResult> {
  const accountId = job.accountId as number;
  const last = p.events[p.events.length - 1];
  const scheduled = (job.triggerCode ?? '').startsWith('schedule_') || p.scheduled;
  const trigger: T3Trigger = job.origin === 'manual'
    ? { type: 'manual', requestedByUserId: p.requestedByUserId ?? null }
    : scheduled
      ? { type: 'scheduled' }
      : {
        type: 'event', event: last?.event, objectType: last?.objectType,
        objectId: last?.objectId, correlationId: last?.correlationId,
      };
  const scope = p.scope ?? (trigger.type === 'manual' ? 'full' : 'incremental');

  // Relecture : une exécution compte plus récente que la demande la couvre
  // déjà. Jamais pour un lancement manuel (WF-11 : toujours exécuté). Un
  // travail événementiel n'est couvert que par une exécution `full` (le
  // périmètre incrémental d'une autre exécution ne contient pas forcément
  // l'objet de l'événement).
  if (job.origin !== 'manual' && deps.accountReconciledSince) {
    const since = latest(job.createdAt, p.requestedAt, ...p.events.map((e) => e.at));
    if (await deps.accountReconciledSince(accountId, since, trigger.type === 'event')) {
      return { result: 'SUPERSEDED', detail: { accountId, since: since.toISOString() } };
    }
  }

  const result = await deps.reconcileAccount(accountId, trigger, {
    scope, guard, userId: p.requestedByUserId ?? undefined, triggerCode: job.triggerCode ?? null,
    // Lot 52A (NR-10) : lien run ↔ job, pour reconnaître une exécution orpheline.
    queueJob: { id: job.id, executionId: job.executionId },
  });

  if (result.status === 'skipped_concurrent') {
    // Une AUTRE exécution du compte est réellement en cours (l'orpheline d'un
    // processus arrêté est close par `claim`). Lot 52A : REPORT (5, 15, 60
    // min ; tentative rendue), plus un échec — le backoff d'échec (≈ 7 min 30
    // pour cinq tentatives) épuisait le job avant la fin d'une exécution
    // longue ou de la péremption d'une exécution d'avant ce lot (30 min).
    throw new JobDeferredError('exécution T3 déjà en cours sur ce compte — reprise différée');
  }
  if (result.status === 'skipped_blocked') {
    // T3 coupé entre le prélèvement et le démarrage : interruption, pas
    // échec — le boucleur remet le job en tête sans consommer de tentative
    // (MOD-005, WF-07).
    const { ExecutionCancelledError } = await import('../queue/execution-control');
    throw new ExecutionCancelledError('T3 bloqué au démarrage (arrêt d\'urgence, désactivation ou suspension)');
  }
  if (result.status === 'failed') {
    // Tous les biens examinés en erreur : problème technique, pas un résultat
    // métier — retry + backoff (MOD-005), jamais un DONE silencieux.
    throw new Error(`exécution T3 du compte ${accountId} en échec sur tous les biens examinés (${result.errors} erreur(s))`);
  }
  if (result.outcome === 'TECHNICAL_FAILURE' && result.phases) {
    // Lot 57B (défaut A) : une phase OBLIGATOIRE en échec ou non exécutée n'est
    // jamais un DONE — échec technique, repris par la file (backoff). Les
    // écritures déjà faites sont conservées (idempotentes au passage suivant) ;
    // le passage (`account_reconciliation_runs`, phases) reste consultable.
    const ko = Object.entries(result.phases).filter(([, ph]) => ph.status === 'FAILED' || ph.status === 'NOT_RUN')
      .map(([n, ph]) => `${n} ${ph.status}${ph.error ? ` (${ph.error.slice(0, 120)})` : ''}`);
    throw new Error(`exécution T3 du compte ${accountId} (passage #${result.runId}) : phase(s) obligatoire(s) en échec — ${ko.join(' ; ')}`);
  }
  const detail = {
    runId: result.runId, scope, status: result.status, objectsExamined: result.objectsExamined,
    // Lot 52A (COR-04, COR-05) : objets modifiés et appels modèle du passage
    // (0 = passage sans appel Gemini, tracé comme tel).
    objectsModified: result.objectsModified,
    aiCalls: (result.aiCalls ?? 0) + (result.openActions?.aiCalls ?? 0) + (result.documentNaming?.aiCalls ?? 0),
    openActionsExamined: result.openActions?.examined ?? 0,
    // Lot 54A (écarts 4, 5) : passage GLOBAL du compte — toutes les cartes
    // ouvertes réexaminées ; vraies tentatives distinguées du simple constat.
    openActionsPhase: 'ACCOUNT_GLOBAL',
    openActionsResolutionAttempted: result.openActions?.resolutionAttempted ?? 0,
    // Lot 57B : issue et phases du passage, compteurs distincts (jamais confondus).
    outcome: result.outcome ?? null,
    ...(result.phases ? { phases: result.phases } : {}),
    openActionsOpenAtStart: result.openActions?.openAtStart ?? null,
    openActionsResolved: result.openActions?.resolved ?? null,
    openActionsKeptAmbiguous: result.openActions?.keptAmbiguous ?? null,
    openActionsDelegated: result.openActions?.delegated ?? null,
    openActionsErrors: result.openActions?.errors ?? null,
    aiCallsByOperation: result.openActions?.aiCallsByOperation ?? {},
    journal: result.openActions?.journalStatus ?? null,
    decisionsApplied: result.decisionsApplied, conflictsCreated: result.conflictsCreated, errors: result.errors,
    ...(result.openKnowledge ? { openKnowledge: result.openKnowledge } : {}),
    // Lot 49B : rapport des lignes « À traiter » ouvertes examinées (borné).
    ...(result.openActions ? { openActions: result.openActions } : {}),
    // Lot 61 : harmonisation du nommage documentaire (propositions IA ≠ renommages écrits).
    ...(result.documentNaming ? { documentNaming: summarizeT3Naming(result.documentNaming) } : {}),
  };
  const ok = result.openKnowledge;
  if (ok && ((ok.facts?.retargeted ?? 0) > 0 || ok.documents.enqueued > 0 || ok.titles.updated > 0 || (ok.targeted?.enqueued ?? 0) > 0)) return { result: 'APPLIED', detail };
  const oa = result.openActions;
  if (oa && (oa.byEffect.CLOSED > 0 || oa.byEffect.UPDATED > 0 || oa.byEffect.SUPERSEDED > 0)) return { result: 'APPLIED', detail };
  if (result.decisionsApplied > 0) return { result: 'APPLIED', detail };
  if ((result.documentNaming?.applied ?? 0) > 0) return { result: 'APPLIED', detail };
  if (result.conflictsCreated > 0) return { result: 'ABSTAIN', detail };
  return { result: 'NO_CHANGE', detail };
}

/**
 * Synthèse T3 de l'harmonisation documentaire (lot 72B, E8) — même état que
 * la phase du passage et le rapport détaillé (DONE / PARTIAL / DEFERRED /
 * FAILED / DISABLED / NOT_READY) ; propositions IA, écritures confirmées,
 * refus, conflits, échecs, reprises et travail restant distincts. Pure.
 */
export function summarizeT3Naming(dn: import('./document-naming/phase').DocumentNamingPhaseResult): Record<string, unknown> {
  return {
    status: dn.status, promptAvailable: dn.promptAvailable,
    groupsDue: dn.groupsDue, groupsExamined: dn.groupsExamined, groupsCompleted: dn.groupsCompleted,
    proposals: dn.proposals, applied: dn.applied, refused: dn.refused, conflicts: dn.conflicts, failed: dn.failed,
    renamesSectionMissing: dn.renamesSectionMissing, pendingWrites: dn.pendingWrites ?? 0, writesRetried: dn.writesRetried ?? 0,
    aiCalls: dn.aiCalls, reportId: dn.reportId,
    // Lot 76B : décisions non sauvegardées (C2), recalage : migration technique / réexamen attendu / effectué (C5).
    decisionsUnsaved: dn.decisionsUnsaved ?? 0, documentsRevalidated: dn.documentsRevalidated ?? 0,
    upgrade: dn.upgrade ?? null,
    remainingGroups: dn.remaining?.groups ?? 0, remainingDocuments: dn.remaining?.documents ?? 0,
    remainingByReason: dn.remaining?.byReason ?? {}, nextRetryAt: dn.remaining?.nextRetryAt ?? null,
    scanComplete: dn.scan?.complete ?? null, documents: dn.documents,
  };
}

/**
 * Balayage planifié, PAGINÉ (lot 31C, §18-20 du ticket).
 *
 * La racine (ni compte ni cible, mise en file par `runDueSchedules`) ouvre un
 * cycle logique (`cycleId` = son identifiant) et traite la page 0. Chaque
 * page met en file au plus `sweepPageSize()` travaux compte (identifiants
 * strictement croissants après le curseur), puis UNE continuation
 * (`target_type = 't3_sweep'`, clé unique « cycle:page », insérée seulement
 * si elle n'a jamais existé : une page rejouée après une reprise ne la
 * recrée pas), différée de quelques secondes : les travaux provoqués par les
 * utilisateurs entre-temps passent devant les pages suivantes.
 *
 * Si les travaux planifiés de la page précédente attendent encore (≥ une
 * page), la page ne met rien en file et se reporte (curseur inchangé). Les
 * comptes déjà rationalisés depuis le début du cycle (ou dans la période
 * précédente) sont exclus, les travaux vivants absorbent les doublons : aucun
 * compte perdu (curseur stable), aucun compte traité deux fois dans un cycle.
 * Durable (lignes de file), reprenable (bail, reprise), multi-instances
 * (prélèvement atomique ; un seul cycle vivant à la fois).
 */
/**
 * Balayages ADDITIONNELS ouverts par la racine d'un cycle planifié (lot 31B :
 * rattrapage des documents sans bien principal, T3 DOCUMENT_ASSET). Chaque
 * démarreur ne fait que mettre en file SA première page (bornée, clé unique
 * par cycle) ; sa pagination est la sienne. Un démarreur en échec n'empêche
 * ni les autres ni le balayage des comptes.
 */
export type T3SweepStarter = (ctx: {
  job: QueuedJob; cycleId: string; cycleStartedAt: string; triggerCode: string; guard: ExecutionGuard;
}) => Promise<void>;

const sweepStarters = new Map<string, T3SweepStarter>();

/** Enregistre (ou remplace) un démarreur de balayage additionnel. */
export function registerT3SweepStarter(name: string, starter: T3SweepStarter): void {
  sweepStarters.set(name, starter);
}

async function runSweepStarters(ctx: Parameters<T3SweepStarter>[0]): Promise<void> {
  for (const [name, starter] of sweepStarters) {
    try {
      await starter(ctx);
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      console.error(`[t3-queue] balayage additionnel « ${name} » non démarré :`, (e as Error).message);
    }
  }
}

async function runSweep(job: QueuedJob, p: T3SweepPayload, guard: ExecutionGuard, deps: T3HandlerDeps): Promise<JobBusinessResult> {
  const { SCHEDULE_PERIOD_HOURS, T3_DEFAULT_SCHEDULE_TRIGGER } = await import('../config/catalogs');
  const triggerCode = job.triggerCode && SCHEDULE_PERIOD_HOURS[job.triggerCode] !== undefined
    ? job.triggerCode : T3_DEFAULT_SCHEDULE_TRIGGER;
  const periodHours = SCHEDULE_PERIOD_HOURS[triggerCode];

  const racine = job.targetType == null;
  if (racine && deps.liveSweepPages && (await deps.liveSweepPages()) > 0) {
    // Un cycle précédent pagine encore : il n'est ni doublé ni interrompu.
    return { result: 'SUPERSEDED', detail: { reason: 'cycle de balayage déjà en cours' } };
  }
  const cycleId = racine ? String(job.id) : (p.cycleId as string);
  const cycleStartedAt = racine
    ? (job.startedAt ?? new Date()).toISOString()
    : (p.cycleStartedAt ?? job.createdAt.toISOString());
  const page = racine ? 0 : p.page;
  const after = racine ? 0 : p.afterAccountId;
  if (racine) await runSweepStarters({ job, cycleId, cycleStartedAt, triggerCode, guard });
  const size = sweepPageSize();

  const backlog = deps.sweepBacklog ? await deps.sweepBacklog() : 0;
  let comptes: number[] = [];
  let suivant = after;
  let fin = false;
  if (backlog < size) {
    comptes = await deps.listSweepAccounts({
      since: sweepFreshSince(cycleStartedAt, periodHours),
      afterAccountId: after, limit: size,
    });
    for (const accountId of comptes) {
      await guard.assertActive('mise en file planifiée');
      await deps.enqueue({
        treatment: 'T3',
        scope: { accountId },
        triggerCode,
        payload: buildT3Payload('account', { scope: 'incremental', scheduled: true, sweepCycleId: cycleId }),
      });
    }
    if (comptes.length > 0) suivant = comptes[comptes.length - 1];
    fin = comptes.length < size;
  }

  if (!fin) {
    await guard.assertActive('continuation du balayage');
    await deps.enqueue({
      treatment: 'T3',
      scope: { targetType: T3_TARGET_SWEEP_PAGE, targetId: `${cycleId}:${page + 1}` },
      triggerCode,
      delaySeconds: backlog >= size ? sweepBacklogDelaySeconds() : sweepPageDelaySeconds(),
      payload: buildT3Payload('sweep', { cycleId, cycleStartedAt, afterAccountId: suivant, page: page + 1 }),
      onlyIfNeverQueued: true,
    });
  }
  return {
    result: comptes.length > 0 ? 'APPLIED' : 'NO_CHANGE',
    detail: {
      cycleId, page, afterAccountId: after, enqueued: comptes.length, backlog,
      nextAccountId: fin ? null : suivant, last: fin,
    },
  };
}

/**
 * Fraîcheur d'un compte au balayage (lot 52A, NR-02) : un compte rationalisé
 * depuis cette date n'est pas remis en file par le cycle.
 *
 * Avant : début du cycle − période. Le passage du cycle PRÉCÉDENT se termine
 * forcément APRÈS le début de ce cycle-là, soit un peu moins d'une période
 * avant le cycle courant : il était donc toujours « frais » et le compte était
 * sauté — un balayage « toutes les heures » ne rationalisait chaque compte
 * qu'une heure sur deux (les pages suivantes, différées, jamais à l'heure).
 * Désormais : début du cycle − période / 2. Un passage récent (événement,
 * lancement manuel, dans la dernière demi-période) dispense toujours du
 * balayage ; le passage du cycle précédent, non. Pure, testée.
 */
export function sweepFreshSince(cycleStartedAt: string | Date, periodHours: number): Date {
  return new Date(new Date(cycleStartedAt).getTime() - (periodHours * 3_600_000) / 2);
}

// ── Accès base (exécutant branché) ──────────────────────────────────────────

type Sql = typeof import('@/db').pgClient;
const db = async (): Promise<Sql> => (await import('@/db')).pgClient;

/** Comptes du balayage planifié (exporté pour les tests e2e, lot 61). */
export async function listSweepAccountsFromDb(q: SweepAccountsQuery): Promise<number[]> {
  const sql = await db();
  const verifyHours = Math.floor(envNumber('T3_NAMING_VERIFY_HOURS', 24, { min: 0 }));
  // Même périmètre que l'ancienne planification (comptes ayant des biens,
  // sans exécution T3 réussie ou en cours sur la période), PAGINÉ par
  // identifiant croissant : curseur stable, aucun compte sauté.
  const requete = (nommage: boolean) => `SELECT a.id FROM accounts a
      WHERE a.id > $2
        -- Lot 82A (C-Q10, §3.3) : balayage T3 des seuls comptes éligibles.
        AND ${processingEligibleSql('a.id')}
        AND (EXISTS (SELECT 1 FROM assets s WHERE s.account_id = a.id AND s.deleted_at IS NULL)
             -- Lot 49B : une ligne « À traiter » ouverte est un problème actif, réexaminé à chaque cycle.
             OR EXISTS (SELECT 1 FROM to_process_actions t WHERE t.account_id = a.id AND t.resolved_at IS NULL)${nommage ? `
             -- Lot 61 / 72B (E2) — harmonisation documentaire, même sans bien :
             -- (a) découverte initiale : documents, aucun état de compte « * » ;
             OR (EXISTS (SELECT 1 FROM asset_files f WHERE f.account_id = a.id AND f.deleted_at IS NULL AND f.retained_title IS NOT NULL)
                 AND NOT EXISTS (SELECT 1 FROM document_naming_groups g WHERE g.account_id = a.id AND g.group_key = '*'))
             -- (b) traitement en cours : compte non terminé, ou lot en cours / en reprise / à réécrire /
             --     en réexamen « contexte enrichi » (lot 76B), REDEVENU EXÉCUTABLE (délai de reprise,
             --     plafond journalier, vérification quotidienne du prompt) ;
             OR EXISTS (SELECT 1 FROM document_naming_groups g
                         WHERE g.account_id = a.id
                           AND ((g.group_key = '*' AND g.status <> 'DONE')
                                OR g.status IN ('IN_PROGRESS', 'DEFERRED', 'ERROR', 'WRITE_PENDING', 'UPGRADE_REVIEW'))
                           AND (g.retry_after IS NULL OR g.retry_after <= now()))
             -- (c) traitement terminé puis mutation PERTINENTE (lot 76B, C4 — création, modification,
             --     désactivation ou suppression) : document (import, renommage, suppression, rattachement,
             --     classement), extraction (analyse T1), fait créé, modifié, désactivé ou supprimé (journal de
             --     connaissance 0292, mécanisme existant), Opération (statut, nature, contrat, documents
             --     reliés : historique des Opérations), lien document ↔ bien ;
             OR EXISTS (SELECT 1 FROM document_naming_groups m
                         WHERE m.account_id = a.id AND m.group_key = '*' AND m.status = 'DONE'
                           AND (EXISTS (SELECT 1 FROM asset_files f WHERE f.account_id = a.id AND f.updated_at > m.updated_at)
                                OR EXISTS (SELECT 1 FROM document_extractions e WHERE e.account_id = a.id AND e.updated_at > m.updated_at)
                                OR EXISTS (SELECT 1 FROM document_facts d WHERE d.account_id = a.id AND d.created_at > m.updated_at)
                                OR EXISTS (SELECT 1 FROM account_knowledge_changes k WHERE k.account_id = a.id
                                             AND k.kind IN ('FACT', 'ANALYSIS', 'LINK', 'DOCUMENT_LINK') AND k.changed_at > m.updated_at)
                                OR EXISTS (SELECT 1 FROM business_operations o WHERE o.account_id = a.id AND o.updated_at > m.updated_at)
                                OR EXISTS (SELECT 1 FROM business_operation_history h WHERE h.account_id = a.id AND h.created_at > m.updated_at)
                                OR EXISTS (SELECT 1 FROM business_operation_sources bs WHERE bs.account_id = a.id
                                             AND (bs.created_at > m.updated_at OR bs.superseded_at > m.updated_at))
                                OR EXISTS (SELECT 1 FROM business_operation_contract_details cd
                                             JOIN business_operations o2 ON o2.id = cd.operation_id AND o2.account_id = a.id
                                            WHERE cd.updated_at > m.updated_at)
                                OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = a.id
                                             AND (l.updated_at > m.updated_at OR l.created_at > m.updated_at))))
             -- (d) filet de sécurité (lot 76B, C4) : compte terminé dont le dernier cycle complet de lecture
             --     date de plus de T3_NAMING_VERIFY_HOURS (24 h) — relecture sans appel IA si rien n'a changé
             --     (suppressions physiques, modifications sans horodatage).${verifyHours > 0 ? `
             OR EXISTS (SELECT 1 FROM document_naming_groups v
                         WHERE v.account_id = a.id AND v.group_key = '*' AND v.status = 'DONE'
                           AND v.updated_at < now() - interval '${verifyHours} hours')` : ''}` : ''})
        AND NOT EXISTS (
          SELECT 1 FROM account_reconciliation_runs r
           WHERE r.account_id = a.id AND r.status IN ('completed', 'partial', 'running')
             AND coalesce(r.finished_at, r.started_at) > $1::timestamptz)
      ORDER BY a.id LIMIT $3`;
  const params = [q.since.toISOString(), q.afterAccountId, q.limit] as never[];
  // Table 0450 absente (déploiement partiel) : périmètre historique, jamais un balayage en échec.
  // Harmonisation désactivée (T3_DOCUMENT_NAMING_ENABLED=0) : aucun compte réinscrit à ce seul titre.
  const nommage = process.env.T3_DOCUMENT_NAMING_ENABLED?.trim() !== '0';
  const rows = (await sql.unsafe(requete(nommage), params).catch((e) => {
    if ((e as { code?: string })?.code !== '42P01') throw e;
    return sql.unsafe(requete(false), params);
  })) as unknown as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}

const dbChecks: Required<Pick<T3HandlerDeps,
  'assetExists' | 'assetReconciledSince' | 'accountReconciledSince' | 'liveSweepPages' | 'sweepBacklog'>> = {
  async assetExists(accountId, assetId) {
    const rows = (await (await db()).unsafe(
      `SELECT 1 FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [assetId, accountId] as never[],
    )) as unknown as unknown[];
    return rows.length > 0;
  },
  async assetReconciledSince(accountId, assetId, since) {
    const rows = (await (await db()).unsafe(
      `SELECT 1 FROM reconciliation_runs
        WHERE account_id = $1 AND asset_id = $2 AND status = 'completed' AND started_at > $3::timestamptz LIMIT 1`,
      [accountId, assetId, since.toISOString()] as never[],
    )) as unknown as unknown[];
    return rows.length > 0;
  },
  async accountReconciledSince(accountId, since, fullOnly) {
    const rows = (await (await db()).unsafe(
      `SELECT 1 FROM account_reconciliation_runs
        WHERE account_id = $1 AND status = 'completed' AND started_at > $2::timestamptz
          AND ($3::boolean IS FALSE OR scope = 'full') LIMIT 1`,
      [accountId, since.toISOString(), fullOnly] as never[],
    )) as unknown as unknown[];
    return rows.length > 0;
  },
  async liveSweepPages() {
    const rows = (await (await db()).unsafe(
      `SELECT count(*)::int AS n FROM ai_job_queue
        WHERE treatment = 'T3' AND target_type = $1 AND status IN ('PENDING', 'RUNNING')`,
      [T3_TARGET_SWEEP_PAGE] as never[],
    )) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  },
  async sweepBacklog() {
    const rows = (await (await db()).unsafe(
      `SELECT count(*)::int AS n FROM ai_job_queue
        WHERE treatment = 'T3' AND status = 'PENDING' AND account_id IS NOT NULL
          AND target_type IS NULL AND trigger_code LIKE 'schedule\\_%'`,
      [] as never[],
    )) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  },
};

/**
 * Exécutant T3 branché sur la base — enregistré au démarrage par
 * `registerReconciliationHandlers` (reconciliation/index.ts), AVANT le
 * démarrage du boucleur dans `instrumentation.ts`.
 */
export async function t3JobHandler(job: QueuedJob, guard: ExecutionGuard): Promise<JobBusinessResult> {
  const [{ reconcileAsset }, { reconcileAccount }, { enqueue }, { reconcileEntity }] = await Promise.all([
    import('./reconciliation-engine'),
    import('./account-reconciliation.service'),
    import('../queue/job-queue.repository'),
    import('./entity-reconciliation'),
  ]);
  return runT3Job(job, guard, {
    reconcileAsset, reconcileAccount, enqueue, listSweepAccounts: listSweepAccountsFromDb,
    reconcileEntity: (i) => reconcileEntity(i),
    ...dbChecks,
  });
}
