/**
 * Déclenchement de la projection Agenda des Opérations (lot 46, O7 ; CDC
 * Opérations V1 C16.2, C21.1, C4 déclencheur Agenda, C24 NFR-OP-006).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BUS OPÉRATIONS (après commit) → TRAVAIL DÉDOUBLONNÉ PAR COMPTE → PROJECTION
 *
 *   · abonné « t4-agenda-projection » du bus Opérations : chaque événement
 *     BUSINESS_OPERATION_* VALIDÉ met en file (file durable existante, sorte
 *     T3 `business_operations_agenda`, un travail par compte, événements
 *     fusionnés `append_events`, court délai pour regrouper une rafale et
 *     laisser T4 documentaire passer d'abord) ; un transfert de bien met
 *     aussi en file le compte quitté (projections orphelines) ;
 *   · l'exécutant relit l'état (jamais l'événement seul) : rejouable,
 *     idempotent, NO-OP si rien ne change ; une erreur n'annule jamais
 *     l'Opération (NFR-OP-006) ;
 *   · lot 83E (C-Q9) : le balayage horaire de convergence (racine T3) est
 *     RETIRÉ — un événement de bus perdu est rattrapé par le contrôle de
 *     cohérence (COH-AGENDA-OPERATION-PROJECTION, COH-AGENDA-PROJECTION-
 *     ORPHANS : plan simulé puis même moteur), une seule chaîne.
 *
 * DÉCLENCHEUR AGENDA → T3 (C4, TRG-012 à TRG-014) : seulement un geste
 * UTILISATEUR sur un élément lié à une Opération, ou (lot 47B) sur un élément
 * saisi qui décrit une intervention (`notifyAgendaChangedForOperations`,
 * appelé par `AgendaWriteService`). Les écritures de la projection n'en
 * émettent jamais : la boucle T3 → T4 → Agenda → T3 est coupée (17.1).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type { QueuedJob } from '@/services/ai/queue/job-queue.repository';
import type { ExecutionGuard } from '@/services/ai/queue/execution-control';
import { PermanentJobError, type JobBusinessResult } from '@/services/ai/queue/queue-policy';
import { buildT3Payload, parseTargetId, registerT3JobKind } from '@/services/ai/reconciliation/t3-job-contract';
import { subscribeBusinessOperationEvents, type BusinessOperationEvent } from '../events';
import { agendaChangeTriggersT3 } from './model';

export const AGENDA_PROJECTION_KIND = 'business_operations_agenda';
export const T3_TARGET_AGENDA_PROJECTION = 'business_operations_agenda';
export const AGENDA_PROJECTION_SUBSCRIBER = 't4-agenda-projection';
/** Regroupement d'une rafale d'événements d'un compte (secondes). */
export const AGENDA_PROJECTION_DELAY_SECONDS = 30;
/** Au-delà, la liste fusionnée a pu être tronquée (`MAX_MERGED_EVENTS`) : passage complet. */
const FULL_PASS_EVENTS = 40;

export interface AgendaProjectionEvent {
  operationIds?: number[];
  /** Passage complet du compte (balayage, transfert, liste tronquée). */
  all?: boolean;
  correlationId?: string;
  at?: string;
}

export interface AgendaProjectionPayload {
  kind: typeof AGENDA_PROJECTION_KIND;
  accountId: number;
  events: AgendaProjectionEvent[];
  requestedAt: string | null;
}

export interface AgendaProjectionQueueDeps {
  enqueue: typeof import('@/services/ai/queue/job-queue.repository').enqueue;
}

async function defaultDeps(): Promise<AgendaProjectionQueueDeps> {
  const { enqueue } = await import('@/services/ai/queue/job-queue.repository');
  return { enqueue };
}

/** Met en file la projection d'un compte (créée ou absorbée par le travail vivant). */
export async function requestAgendaProjection(
  accountId: number, event: AgendaProjectionEvent, deps?: AgendaProjectionQueueDeps, now: Date = new Date(),
): Promise<number | null> {
  if (!Number.isInteger(accountId) || accountId <= 0) return null;
  const d = deps ?? await defaultDeps();
  const e: AgendaProjectionEvent = {
    ...(event.operationIds?.length ? { operationIds: [...new Set(event.operationIds.filter((x) => Number.isSafeInteger(x) && x > 0))] } : {}),
    ...(event.all ? { all: true } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    at: now.toISOString(),
  };
  const { jobId } = await d.enqueue({
    treatment: 'T3',
    scope: { accountId, targetType: T3_TARGET_AGENDA_PROJECTION, targetId: String(accountId) },
    triggerCode: null,
    payload: buildT3Payload(AGENDA_PROJECTION_KIND, { events: [e] }, now),
    payloadOnDedupe: 'append_events',
    delaySeconds: AGENDA_PROJECTION_DELAY_SECONDS,
  });
  return jobId;
}

/** Abonné du bus Opérations. Ne lève jamais (un abonné ne bloque ni l'écriture ni les autres abonnés). */
export async function onBusinessOperationEventForAgenda(e: BusinessOperationEvent, deps?: AgendaProjectionQueueDeps): Promise<void> {
  try {
    await requestAgendaProjection(e.accountId, {
      operationIds: [e.operationId, ...(e.canonicalOperationId ? [e.canonicalOperationId] : [])],
      correlationId: e.correlationId,
    }, deps);
    if (e.previousAccountId && e.previousAccountId !== e.accountId) {
      await requestAgendaProjection(e.previousAccountId, { all: true, correlationId: e.correlationId }, deps);
    }
  } catch (err) {
    console.error(`[t4-projection] mise en file impossible (compte ${e.accountId}, Opération ${e.operationId}) :`, (err as Error).message);
  }
}

function parseEvents(job: Pick<QueuedJob, 'id'>, raw: unknown): AgendaProjectionEvent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PermanentJobError(`T3 job ${job.id} : events n'est pas une liste`);
  return raw.map((x) => {
    if (typeof x !== 'object' || x === null) throw new PermanentJobError(`T3 job ${job.id} : événement malformé`);
    const o = x as Record<string, unknown>;
    const ids = Array.isArray(o.operationIds) ? o.operationIds.filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0) : [];
    return {
      ...(ids.length ? { operationIds: ids } : {}),
      ...(o.all === true ? { all: true } : {}),
      ...(typeof o.correlationId === 'string' ? { correlationId: o.correlationId } : {}),
      ...(typeof o.at === 'string' ? { at: o.at } : {}),
    };
  });
}

/** Exécutant de la sorte `business_operations_agenda`. */
export async function runAgendaProjectionJob(job: QueuedJob, p: AgendaProjectionPayload, guard: ExecutionGuard): Promise<JobBusinessResult> {
  const { pgClient } = await import('@/db');
  const [compte] = (await pgClient.unsafe(`SELECT 1 FROM accounts WHERE id = $1`, [p.accountId] as never[])) as unknown as unknown[];
  if (!compte) return { result: 'TARGET_GONE', detail: { accountId: p.accountId } };
  const all = p.events.some((e) => e.all) || p.events.length >= FULL_PASS_EVENTS;
  const operationIds = [...new Set(p.events.flatMap((e) => e.operationIds ?? []))];
  const correlationId = [...p.events].reverse().find((e) => e.correlationId)?.correlationId ?? `t4-projection:${job.id}`;
  const { projectAccountOperations } = await import('./service');
  const res = await projectAccountOperations(p.accountId, {
    ...(all ? { all: true } : { operationIds }),
    correlationId,
    beforeWrite: (what) => guard.assertActive(what),
  });
  // Lot 87B (CODE-02) : une décision T3 (création, fusion, séparation, modification) a rejoué la projection ;
  // là où plusieurs représentations restent possibles, la décision est demandée à T4 — même travail durable,
  // plafonds existants, aucune fusion par le code.
  let semantique: Awaited<ReturnType<typeof import('../semantic/orchestrator').reevaluateRequestedRepresentations>> | null = null;
  if (res.representationRequired?.length) {
    const { reevaluateRequestedRepresentations } = await import('../semantic/orchestrator');
    semantique = await reevaluateRequestedRepresentations(p.accountId, res.representationRequired, {
      trigger: 'T3_DECISION', correlationId, triggerRef: `t4-projection:${job.id}`, beforeWrite: (what) => guard.assertActive(what),
    });
  }
  const detail = { accountId: p.accountId, ...res, ...(semantique ? { semantic: semantique } : {}) };
  return { result: res.changes > 0 || (semantique?.applied ?? 0) > 0 ? 'APPLIED' : 'NO_CHANGE', detail };
}

/**
 * Enregistre la sorte de travail et l'abonnement au bus. Réentrant : un
 * second appel remplace (même nom), jamais de double abonnement.
 */
export function registerOperationAgendaProjection(): void {
  registerT3JobKind<AgendaProjectionPayload>({
    kind: AGENDA_PROJECTION_KIND,
    targetTypes: [T3_TARGET_AGENDA_PROJECTION],
    account: 'required',
    versions: [1],
    parse(raw, job) {
      const accountId = parseTargetId(job);
      if (accountId !== job.accountId) throw new PermanentJobError(`T3 job ${job.id} : cible ${accountId} différente du compte ${String(job.accountId)}`);
      return {
        kind: AGENDA_PROJECTION_KIND, accountId, events: parseEvents(job, raw.events),
        requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : null,
      };
    },
    run: ({ job, payload, guard }) => runAgendaProjectionJob(job, payload, guard),
  });
  subscribeBusinessOperationEvents(AGENDA_PROJECTION_SUBSCRIBER, (e) => onBusinessOperationEventForAgenda(e));
}

// ── Déclencheur Agenda → T3 (C4) ───────────────────────────────────────────

/**
 * Geste utilisateur sur un élément d'agenda (modification, statut,
 * suppression) : si l'élément est lié à une Opération, T3 est demandé
 * (déclencheur `agenda_changed`, avec une corrélation). Ne lève jamais.
 * Rend vrai si une demande T3 est partie.
 */
export function notifyAgendaChangedForOperations(accountId: number, p: {
  itemId: number;
  businessOperationId: number | null;
  userFieldsChanged: boolean;
  /** Lot 47B (TRG-012) : élément non lié qui peut établir une intervention. */
  candidate?: boolean;
  correlationId?: string;
}): boolean {
  if (!agendaChangeTriggersT3({
    businessOperationId: p.businessOperationId, fromProjection: false, userFieldsChanged: p.userFieldsChanged, candidate: p.candidate,
  })) return false;
  void import('../consolidation/queue')
    .then(({ notifyOperationsEvent }) => notifyOperationsEvent(accountId, {
      trigger: 'agenda_changed', agendaItemId: p.itemId, correlationId: p.correlationId ?? `agenda:${p.itemId}:${randomUUID()}`,
    }))
    .catch((e: Error) => console.error(`[t4-projection] déclencheur Agenda (élément ${p.itemId}) :`, e.message));
  return true;
}
