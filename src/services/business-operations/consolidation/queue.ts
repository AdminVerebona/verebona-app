/**
 * T3 Opérations sur la file durable — déclencheurs C4 (lot 41, O3a ; CDC
 * Opérations V1 ch. 6, B4, C4, C24 NFR-OP-001/004/005, C30 performance).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SORTE DE TRAVAIL DÉDIÉE, DANS LA FILE EXISTANTE (C23 : pas de 2e file)
 *
 *   kind `business_operations`        cible `business_operations`, compte requis
 *                                     (clé de déduplication T3:a<compte>:business_operations:<compte>)
 *   kind `business_operations_sweep`  pages du balayage horaire (sans compte)
 *
 * Un travail par compte, dédoublonné (WF-10 : les événements rapprochés
 * fusionnent, `append_events`) et SÉRIALISÉ par le verrou consultatif du
 * compte (lot 39) : deux exécutions concurrentes ne produisent jamais deux
 * Opérations pour un même candidat.
 *
 * DÉCLENCHEURS C4 → code du catalogue T3 existant (version effective BO) :
 *
 *   source_analyzed / source_reanalyzed          → source_analyzed   (TRG-001/002)
 *   document_deleted / document_restored /
 *   document_linked / document_moved /
 *   document_reclassified                        → document_linked   (TRG-003 à 007)
 *   asset_updated / asset_disposed               → asset_updated     (TRG-008 à 010 ;
 *                                                  lot 43 : données structurées
 *                                                  du bien → sources ASSET_DATA)
 *   arbitration_resolved (lot 42)                → document_linked   (TRG-018)
 *   agenda_changed (lot 46, O7)                  → asset_updated     (TRG-012 à 014 :
 *                                                  geste UTILISATEUR sur un élément
 *                                                  d'agenda lié à une Opération, ou
 *                                                  — lot 47B — sur un élément saisi
 *                                                  qui décrit une intervention ;
 *                                                  jamais une écriture de projection,
 *                                                  C16.2 ; lot 47B : l'élément est
 *                                                  réconcilié en source AGENDA,
 *                                                  `agenda-source-consolidator.ts`)
 *   balayage                                     → schedule_hourly   (TRG-020)
 *   admin_reconsolidation (lot 48, O10)          → manual            (bouton BO
 *                                                  « Reconsolider ce compte » :
 *                                                  jamais soumis à la version
 *                                                  effective, comme le balayage ;
 *                                                  passage COMPLET du compte,
 *                                                  `runOperationsJob`)
 *
 * Aucun code n'est ajouté au catalogue (les versions de configuration
 * existantes restent valides) ; le code C4 précis voyage dans les événements
 * du contexte (diagnostic). L'état fait foi, pas l'événement : le passage
 * relit les candidats en attente et les sources obsolètes, un événement perdu
 * (bornage à 50 événements fusionnés) est rattrapé.
 *
 * ANTI-BOUCLE (C16.2) : aucun déclencheur sur les tables `business_operation*`
 * ni sur le bus des événements Opération ; la corrélation de la demande est
 * transmise aux écritures (préparation T4, lot O7).
 *
 * BALAYAGE HORAIRE : démarreur branché sur la racine du balayage planifié T3
 * (`registerT3SweepStarter`), pages bornées par compte (curseur stable), et
 * SEULEMENT les comptes qui ont quelque chose à consolider — un compte sans
 * candidat en attente, sans source obsolète, sans contrat arrivé à date
 * d'effet, sans rapprochement M3 dû, n'est jamais mis en file (NFR-OP-005,
 * INV-040). Le balayage lui-même n'appelle aucune IA.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type { QueuedJob } from '@/services/ai/queue/job-queue.repository';
import type { ExecutionGuard } from '@/services/ai/queue/execution-control';
import { PermanentJobError, type JobBusinessResult } from '@/services/ai/queue/queue-policy';
import { buildT3Payload, parseTargetId, registerT3JobKind } from '@/services/ai/reconciliation/t3-job-contract';
import { envNumber } from '@/lib/env-number';

export const T3_TARGET_BUSINESS_OPERATIONS = 'business_operations';
export const BUSINESS_OPERATIONS_KIND = 'business_operations';
export const T3_TARGET_BUSINESS_OPERATIONS_SWEEP = 'business_operations_sweep';
export const BUSINESS_OPERATIONS_SWEEP_KIND = 'business_operations_sweep';

/** Codes C4 portés par les demandes (CDC Opérations V1 C4). */
export const C4_TRIGGERS = [
  'source_analyzed', 'source_reanalyzed', 'document_deleted', 'document_restored', 'document_linked',
  'document_moved', 'document_reclassified', 'asset_updated', 'asset_disposed', 'arbitration_resolved', 'agenda_changed', 'schedule_hourly',
  'admin_reconsolidation',
] as const;
export type C4Trigger = (typeof C4_TRIGGERS)[number];

/** Code C4 → déclencheur du catalogue T3 (contrôlé par la version effective). */
export const C4_CATALOG_TRIGGER: Readonly<Record<C4Trigger, string>> = {
  source_analyzed: 'source_analyzed',
  source_reanalyzed: 'source_analyzed',
  document_deleted: 'document_linked',
  document_restored: 'document_linked',
  document_linked: 'document_linked',
  document_moved: 'document_linked',
  document_reclassified: 'document_linked',
  asset_updated: 'asset_updated',
  asset_disposed: 'asset_updated',
  // TRG-018 : décision « À traiter » appliquée — même périmètre qu'une correction de rattachement.
  arbitration_resolved: 'document_linked',
  // Lot 46 (O7) : correction utilisateur d'un élément d'agenda lié — même
  // périmètre qu'une correction de donnée du bien (aucun code catalogue ajouté).
  agenda_changed: 'asset_updated',
  schedule_hourly: 'schedule_hourly',
  // Lot 48 (O10) : demande d'un administrateur (BO › Opérations du compte) —
  // code `manual` des lancements BO, hors contrôle de la version effective.
  admin_reconsolidation: 'manual',
};

/** Codes jamais soumis au catalogue de déclencheurs de la version effective. */
const UNGATED_CODES: ReadonlySet<string> = new Set(['schedule_hourly', 'manual']);

export interface OperationsEvent {
  trigger: C4Trigger;
  fileId?: number;
  assetId?: number;
  /** Lot 46 (O7) : élément d'agenda modifié par l'utilisateur (`agenda_changed`). */
  agendaItemId?: number;
  /** Lot 84E (O-6) : Pièce créée ou modifiée (`asset_updated`) — reconsolidation ciblée. */
  roomId?: number;
  correlationId?: string;
  at?: string;
}

export interface OperationsPayload {
  kind: typeof BUSINESS_OPERATIONS_KIND;
  accountId: number;
  events: OperationsEvent[];
  requestedAt: string | null;
}

export interface OperationsSweepPayload {
  kind: typeof BUSINESS_OPERATIONS_SWEEP_KIND;
  cycleId: string;
  page: number;
  afterAccountId: number;
  requestedAt: string | null;
}

export interface OperationsQueueDeps {
  enqueue: typeof import('@/services/ai/queue/job-queue.repository').enqueue;
  isTriggerActive: (treatment: 'T3', code: string) => Promise<boolean>;
}

async function defaultDeps(): Promise<OperationsQueueDeps> {
  const [{ enqueue }, { isTriggerActive }] = await Promise.all([
    import('@/services/ai/queue/job-queue.repository'),
    import('@/services/ai/queue/triggers'),
  ]);
  return { enqueue, isTriggerActive };
}

/**
 * Demande la consolidation T3 des Opérations d'un compte après un événement
 * C4. Rend l'identifiant du travail (créé ou absorbant), `null` si le
 * déclencheur est inactif dans la version effective. Lève si la mise en file
 * échoue (SCR-08) — les appelants non bloquants utilisent
 * `notifyOperationsEvent`.
 */
export async function requestOperationsConsolidation(
  accountId: number, event: OperationsEvent, deps?: OperationsQueueDeps, now: Date = new Date(),
): Promise<number | null> {
  if (!Number.isInteger(accountId) || accountId <= 0) return null;
  const d = deps ?? await defaultDeps();
  const code = C4_CATALOG_TRIGGER[event.trigger];
  if (!code || (!UNGATED_CODES.has(code) && !(await d.isTriggerActive('T3', code)))) return null;
  const e: OperationsEvent = { ...event, correlationId: event.correlationId ?? randomUUID(), at: now.toISOString() };
  const { jobId } = await d.enqueue({
    treatment: 'T3',
    scope: { accountId, targetType: T3_TARGET_BUSINESS_OPERATIONS, targetId: String(accountId) },
    triggerCode: code,
    payload: buildT3Payload(BUSINESS_OPERATIONS_KIND, { events: [e] }, now),
    payloadOnDedupe: 'append_events',
  });
  return jobId;
}

/** Non bloquant : un événement métier n'échoue jamais à cause de T3 Opérations. */
export function notifyOperationsEvent(accountId: number, event: OperationsEvent): void {
  void requestOperationsConsolidation(accountId, event).catch((e) =>
    console.error(`[t3-operations] demande « ${event.trigger} » non enregistrée (compte ${accountId}) :`, (e as Error).message));
}

/**
 * Fin d'analyse T1 (TRG-001 / TRG-002) : mise en file seulement si le
 * document a des candidats en attente de T3. Ne lève jamais.
 */
export async function onDocumentAnalyzedForOperations(accountId: number, fileId: number): Promise<number | null> {
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT trigger_code FROM document_operation_candidates
        WHERE file_id = $1 AND account_id = $2 AND t3_pending ORDER BY id DESC LIMIT 1`,
      [fileId, accountId] as never[],
    )) as unknown as Array<{ trigger_code: string }>;
    if (!r.length) return null;
    const trigger: C4Trigger = r[0].trigger_code === 'source_reanalyzed' ? 'source_reanalyzed' : 'source_analyzed';
    return await requestOperationsConsolidation(accountId, { trigger, fileId });
  } catch (e) {
    console.error(`[t3-operations] fin d'analyse du document ${fileId} :`, (e as Error).message);
    return null;
  }
}

// ── Exécutants ──────────────────────────────────────────────────────────────

const entier = (job: Pick<QueuedJob, 'id'>, raw: Record<string, unknown>, key: string): number => {
  const v = raw[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new PermanentJobError(`T3 job ${job.id} : ${key} invalide`);
  return v;
};

function parseEvents(job: Pick<QueuedJob, 'id'>, raw: unknown): OperationsEvent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PermanentJobError(`T3 job ${job.id} : events n'est pas une liste`);
  const out: OperationsEvent[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) throw new PermanentJobError(`T3 job ${job.id} : événement malformé`);
    const o = e as Record<string, unknown>;
    if (typeof o.trigger !== 'string' || !(C4_TRIGGERS as readonly string[]).includes(o.trigger)) {
      throw new PermanentJobError(`T3 job ${job.id} : déclencheur C4 « ${String(o.trigger)} » inconnu`);
    }
    const id = (k: string) => (typeof o[k] === 'number' && Number.isInteger(o[k]) && (o[k] as number) > 0 ? o[k] as number : undefined);
    out.push({
      trigger: o.trigger as C4Trigger,
      ...(id('fileId') ? { fileId: id('fileId') } : {}),
      ...(id('assetId') ? { assetId: id('assetId') } : {}),
      ...(id('agendaItemId') ? { agendaItemId: id('agendaItemId') } : {}),
      ...(id('roomId') ? { roomId: id('roomId') } : {}),
      ...(typeof o.correlationId === 'string' ? { correlationId: o.correlationId } : {}),
      ...(typeof o.at === 'string' ? { at: o.at } : {}),
    });
  }
  return out;
}

/** Passage T3 Opérations d'un compte (exécutant de la sorte `business_operations`). */
export async function runOperationsJob(job: QueuedJob, p: OperationsPayload, guard: ExecutionGuard): Promise<JobBusinessResult> {
  const { pgClient } = await import('@/db');
  const [compte] = (await pgClient.unsafe(`SELECT 1 FROM accounts WHERE id = $1`, [p.accountId] as never[])) as unknown as unknown[];
  if (!compte) return { result: 'TARGET_GONE', detail: { accountId: p.accountId } };
  const { consolidateAccountOperations } = await import('./consolidator');
  const fileIds = [...new Set(p.events.map((e) => e.fileId).filter((f): f is number => !!f))];
  // Lot 43 (TRG-008 à TRG-010) : biens dont une donnée structurée a changé.
  const assetIds = [...new Set(p.events
    .filter((e) => e.trigger === 'asset_updated' || e.trigger === 'asset_disposed')
    .map((e) => e.assetId).filter((a): a is number => !!a))];
  // Lot 47B (TRG-012 à TRG-014) : éléments d'agenda modifiés par l'utilisateur.
  const agendaItemIds = [...new Set(p.events
    .filter((e) => e.trigger === 'agenda_changed')
    .map((e) => e.agendaItemId).filter((a): a is number => !!a))];
  // Lot 48 (O10) : « Reconsolider ce compte » (BO) — passage COMPLET : données
  // structurées de tous les biens, réexamen des attentes, puis chaque
  // Opération active recalculée depuis ses sources (aucune écriture si rien
  // n'a changé, INV-040). Jamais une édition d'Opération (décision PO Q9).
  const admin = p.events.find((e) => e.trigger === 'admin_reconsolidation');
  const correlationId = admin?.correlationId ?? p.events.find((e) => e.correlationId)?.correlationId ?? `t3-operations:${job.id}`;
  // Lot 54D (E08) : reconsolidation complète — TOUS les biens (pages sur
  // curseur, plus de borne à 500) et couverture des CANDIDATS : chaque
  // candidat actif du compte est remis en consolidation (traité par pages de
  // DOCUMENTS_PER_RUN, passages enchaînés jusqu'à épuisement).
  const tousLesBiens = admin ? await listAccountAssetsForReconsolidation(p.accountId) : [];
  const candidatsRemis = admin ? await requeueAccountCandidates(p.accountId) : 0;
  // Lot 55B (C) : « Reconsolider ce compte » réexamine aussi les échéances déjà
  // consolidées seules sur leur Opération (mêmes règles que le rattrapage 0398).
  if (admin) {
    const { requestAccountRetroReconciliation } = await import('./retro');
    await requestAccountRetroReconciliation(p.accountId);
  }
  // Lot 84E (CDC v5 O-6, §9.3) : un bien ou une Pièce créé / modifié est une
  // information structurante — reconsolidation CIBLÉE (séries récurrentes du
  // bien, Opérations de la Pièce, liens directs), avant le passage du compte.
  if (!admin) {
    const { reconsolidateForAsset, reconsolidateForRoom } = await import('./targeted');
    const base = { trigger: 'asset_updated', correlationId, beforeWrite: (what: string) => guard.assertActive(what) };
    const pieces = [...new Set(p.events.map((e) => e.roomId).filter((x): x is number => !!x))];
    for (const roomId of pieces) await reconsolidateForRoom(p.accountId, roomId, { ...base, trigger: 'room_updated' });
    for (const assetId of assetIds) await reconsolidateForAsset(p.accountId, assetId, base);
  }
  const res = await consolidateAccountOperations(p.accountId, {
    fileIds,
    assetIds: [...new Set([...assetIds, ...tousLesBiens])],
    agendaItemIds,
    reevaluateHolds: !!admin || p.events.some((e) => e.trigger === 'asset_updated' || e.trigger === 'asset_disposed' || e.trigger === 'arbitration_resolved'),
    correlationId,
    beforeWrite: (what) => guard.assertActive(what),
    jobId: job.id,
  });
  let reconsolidation: AdminReconsolidationReport | undefined;
  if (admin) {
    const r = await reconsolidateAllActiveOperations(p.accountId, { correlationId, beforeWrite: (what) => guard.assertActive(what) });
    res.changes += r.changes;
    res.errors += r.errors;
    res.reconsolidated = r.operations;
    reconsolidation = adminReconsolidationReport({
      assets: tousLesBiens.length, candidatesRequeued: candidatsRemis, operations: r.operations, operationBatchesFailed: r.errors,
      documentsRemaining: res.remaining, technicalErrors: res.technicalErrors?.length ?? 0,
    });
    // Couverture des projections : la projection Agenda COMPLÈTE suit (curseur, E07).
    const { requestAgendaProjection } = await import('../agenda-projection/queue');
    await requestAgendaProjection(p.accountId, { all: true, correlationId });
  }
  if (res.remaining) {
    // Passage consolidé suivant (le travail vivant est marqué « à repasser », WF-10).
    await requestOperationsConsolidation(p.accountId, { trigger: 'schedule_hourly' });
  }
  const detail = { accountId: p.accountId, ...res, ...(reconsolidation ? { reconsolidation } : {}) };
  // Lot 54D (E01) : une erreur technique subsiste → jamais APPLIED / NO_CHANGE
  // (succès global interdit) ; la reprise automatique est programmée.
  if (res.errors > 0) return { result: 'FAILED', detail: { ...detail, failure: 'T3_TECHNICAL_ERRORS' } };
  if (res.changes > 0) return { result: 'APPLIED', detail };
  if ((res.outcomes.HOLD_UNRESOLVED ?? 0) > 0 || (res.outcomes.ARBITRATION_REQUIRED ?? 0) > 0) return { result: 'ABSTAIN', detail };
  return { result: 'NO_CHANGE', detail };
}

/** Lot 48 (O10) puis 54D (E08) : taille des pages de biens d'une reconsolidation complète (plus de plafond). */
export const ADMIN_RECONSOLIDATION_PAGE_ASSETS = 500;
/** Lot 54D (E08) : taille des pages d'Opérations (curseur stable) ; chaque lot de 100 = une transaction. */
export const ADMIN_RECONSOLIDATION_PAGE_OPERATIONS = 2_000;
const ADMIN_RECONSOLIDATION_BATCH = 100;

/** Lot 54D (E08) : statut d'une reconsolidation complète, avec compteurs. */
export interface AdminReconsolidationReport {
  /** COMPLET : tout traité ; PARTIEL : passages suivants en file (documents restants) ; ERREUR : erreurs techniques. */
  status: 'COMPLET' | 'PARTIEL' | 'ERREUR';
  assets: number;
  candidatesRequeued: number;
  operations: number;
  operationBatchesFailed: number;
  documentsRemaining: boolean;
  technicalErrors: number;
}

/** Statut d'une reconsolidation (pure) : aucun traitement tronqué n'est déclaré terminé. */
export function adminReconsolidationReport(x: Omit<AdminReconsolidationReport, 'status'>): AdminReconsolidationReport {
  const status = x.operationBatchesFailed > 0 || x.technicalErrors > 0 ? 'ERREUR' : x.documentsRemaining ? 'PARTIEL' : 'COMPLET';
  return { status, ...x };
}

async function listAccountAssetsForReconsolidation(accountId: number): Promise<number[]> {
  const { pgClient } = await import('@/db');
  const out: number[] = [];
  let curseur = 0;
  for (;;) {
    const r = ((await pgClient.unsafe(
      `SELECT id FROM assets WHERE account_id = $1 AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $3`,
      [accountId, curseur, ADMIN_RECONSOLIDATION_PAGE_ASSETS] as never[],
    )) as unknown as Array<{ id: number }>).map((x) => Number(x.id));
    out.push(...r);
    if (r.length < ADMIN_RECONSOLIDATION_PAGE_ASSETS) return out;
    curseur = r[r.length - 1];
  }
}

/** Lot 54D (E08) : candidats actifs du compte remis en consolidation (couverture complète des sources documentaires). */
async function requeueAccountCandidates(accountId: number): Promise<number> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `UPDATE document_operation_candidates SET t3_pending = true
      WHERE account_id = $1 AND status = 'ACTIVE' AND NOT t3_pending RETURNING id`,
    [accountId] as never[],
  )) as unknown as unknown[];
  return r.length;
}

/**
 * Recalcule chaque Opération active (non fusionnée) du compte depuis ses
 * sources, par lots d'une transaction chacun (verrou du compte). Une erreur
 * d'intégrité sur un lot est comptée, les autres lots passent. Lot 54D
 * (E08) : pages sur curseur stable jusqu'à épuisement — plus de plafond à
 * 2 000 ; une interruption (garde) lève, le travail est rejoué (idempotent :
 * un lot déjà cohérent n'écrit rien).
 */
export async function reconsolidateAllActiveOperations(
  accountId: number, opts: { correlationId?: string; beforeWrite?: (what: string) => Promise<void>; today?: string } = {},
): Promise<{ operations: number; changes: number; errors: number; truncated: boolean }> {
  const { pgClient } = await import('@/db');
  const { reconsolidateOperations } = await import('./consolidator');
  const { isBusinessOperationIntegrityError } = await import('../errors');
  let changes = 0;
  let errors = 0;
  let total = 0;
  let curseur = 0;
  for (;;) {
    const ids = ((await pgClient.unsafe(
      `SELECT id FROM business_operations
        WHERE account_id = $1 AND invalidated_at IS NULL AND merged_into_operation_id IS NULL AND id > $2
        ORDER BY id LIMIT $3`,
      [accountId, curseur, ADMIN_RECONSOLIDATION_PAGE_OPERATIONS] as never[],
    )) as unknown as Array<{ id: number }>).map((x) => Number(x.id));
    for (let i = 0; i < ids.length; i += ADMIN_RECONSOLIDATION_BATCH) {
      try {
        changes += await reconsolidateOperations(accountId, ids.slice(i, i + ADMIN_RECONSOLIDATION_BATCH), opts);
      } catch (e) {
        if (!isBusinessOperationIntegrityError(e)) throw e;
        errors++;
        console.error(`[t3-operations] reconsolidation complète (compte ${accountId}) : ${(e as Error).message}`);
      }
    }
    total += ids.length;
    if (ids.length < ADMIN_RECONSOLIDATION_PAGE_OPERATIONS) break;
    curseur = ids[ids.length - 1];
  }
  return { operations: total, changes, errors, truncated: false };
}

/** Comptes mis en file par page de balayage (`T3_OPERATIONS_SWEEP_PAGE_SIZE`, 100 par défaut, 1 à 1000). */
export function operationsSweepPageSize(): number {
  return Math.min(1000, Math.floor(envNumber('T3_OPERATIONS_SWEEP_PAGE_SIZE', 100, { min: 1 })));
}
const pageDelaySeconds = () => Math.floor(envNumber('T3_OPERATIONS_SWEEP_PAGE_DELAY_SECONDS', 30, { min: 0 }));

/** Page du balayage horaire : comptes à consolider après le curseur, puis continuation. */
export async function runOperationsSweepPage(
  job: QueuedJob, p: OperationsSweepPayload, guard: ExecutionGuard, deps?: OperationsQueueDeps,
): Promise<JobBusinessResult> {
  const d = deps ?? await defaultDeps();
  const size = operationsSweepPageSize();
  const triggerCode = job.triggerCode ?? 'schedule_hourly';
  const { listAccountsToConsolidate } = await import('./consolidator');
  // Version effective du prompt T3 (lot 42) : un cas M3 en attente faute de
  // branche OPERATION_MATCH est repris dès qu'une autre version est active.
  const { operationMatchPromptStatus } = await import('./m3');
  const m3 = await operationMatchPromptStatus();
  const comptes = await listAccountsToConsolidate(p.afterAccountId, size, m3.version);
  for (const accountId of comptes) {
    await guard.assertActive('T3 Opérations — mise en file planifiée');
    await d.enqueue({
      treatment: 'T3',
      scope: { accountId, targetType: T3_TARGET_BUSINESS_OPERATIONS, targetId: String(accountId) },
      triggerCode,
      payload: buildT3Payload(BUSINESS_OPERATIONS_KIND, { events: [{ trigger: 'schedule_hourly', correlationId: `t3-operations-sweep:${p.cycleId}` }] }),
      payloadOnDedupe: 'append_events',
    });
  }
  const fin = comptes.length < size;
  if (!fin) {
    await guard.assertActive('T3 Opérations — continuation du balayage');
    await d.enqueue({
      treatment: 'T3',
      scope: { targetType: T3_TARGET_BUSINESS_OPERATIONS_SWEEP, targetId: `${p.cycleId}:${p.page + 1}` },
      triggerCode,
      delaySeconds: pageDelaySeconds(),
      payload: buildT3Payload(BUSINESS_OPERATIONS_SWEEP_KIND, { cycleId: p.cycleId, page: p.page + 1, afterAccountId: comptes[comptes.length - 1] }),
      onlyIfNeverQueued: true,
    });
  }
  return {
    result: comptes.length > 0 ? 'APPLIED' : 'NO_CHANGE',
    detail: { cycleId: p.cycleId, page: p.page, afterAccountId: p.afterAccountId, enqueued: comptes.length, last: fin },
  };
}

/**
 * Démarreur branché sur la racine du balayage planifié T3 : page 0 du cycle
 * (clé unique). Une page d'un cycle précédent encore vivante : aucun nouveau
 * cycle (elle poursuit, curseur stable).
 */
export async function startOperationsSweep(
  ctx: { cycleId: string; triggerCode: string; guard: ExecutionGuard }, deps?: OperationsQueueDeps,
): Promise<void> {
  const d = deps ?? await defaultDeps();
  const { pgClient } = await import('@/db');
  const [{ n }] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T3' AND target_type = $1 AND status IN ('PENDING', 'RUNNING')`,
    [T3_TARGET_BUSINESS_OPERATIONS_SWEEP] as never[],
  )) as unknown as Array<{ n: number }>;
  if (Number(n ?? 0) > 0) return;
  await ctx.guard.assertActive('T3 Opérations — ouverture du balayage');
  await d.enqueue({
    treatment: 'T3',
    scope: { targetType: T3_TARGET_BUSINESS_OPERATIONS_SWEEP, targetId: `${ctx.cycleId}:0` },
    triggerCode: ctx.triggerCode,
    payload: buildT3Payload(BUSINESS_OPERATIONS_SWEEP_KIND, { cycleId: ctx.cycleId, page: 0, afterAccountId: 0 }),
    onlyIfNeverQueued: true,
  });
}

let enregistre = false;

/** Enregistre les deux sortes de travail. Idempotent (démarrage, chargement du module). */
export function registerBusinessOperationsT3(): void {
  if (enregistre) return;
  enregistre = true;
  registerT3JobKind<OperationsPayload>({
    kind: BUSINESS_OPERATIONS_KIND,
    targetTypes: [T3_TARGET_BUSINESS_OPERATIONS],
    account: 'required',
    versions: [1],
    parse(raw, job) {
      const accountId = parseTargetId(job);
      if (accountId !== job.accountId) throw new PermanentJobError(`T3 job ${job.id} : cible ${accountId} différente du compte ${String(job.accountId)}`);
      const requestedAt = raw.requestedAt;
      if (requestedAt !== undefined && requestedAt !== null && (typeof requestedAt !== 'string' || Number.isNaN(new Date(requestedAt).getTime()))) {
        throw new PermanentJobError(`T3 job ${job.id} : requestedAt invalide`);
      }
      return { kind: BUSINESS_OPERATIONS_KIND, accountId, events: parseEvents(job, raw.events), requestedAt: (requestedAt as string | null | undefined) ?? null };
    },
    run: ({ job, payload, guard }) => runOperationsJob(job, payload, guard),
  });
  registerT3JobKind<OperationsSweepPayload>({
    kind: BUSINESS_OPERATIONS_SWEEP_KIND,
    targetTypes: [T3_TARGET_BUSINESS_OPERATIONS_SWEEP],
    account: 'forbidden',
    versions: [1],
    parse(raw, job) {
      const cycleId = raw.cycleId;
      if (typeof cycleId !== 'string' || !cycleId) throw new PermanentJobError(`T3 job ${job.id} : page de balayage Opérations sans cycle`);
      return {
        kind: BUSINESS_OPERATIONS_SWEEP_KIND, cycleId, page: entier(job, raw, 'page'), afterAccountId: entier(job, raw, 'afterAccountId'),
        requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : null,
      };
    },
    run: ({ job, payload, guard }) => runOperationsSweepPage(job, payload, guard),
  });
}

registerBusinessOperationsT3();
