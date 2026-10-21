/**
 * Rapprochement des documents d'un équipement créé ou modifié — exécution
 * DURABLE (lot 75G : ticket « Rapprochement documents–équipements », écart
 * D ; ticket « écarts résiduels 71A », D3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AVANT : la création lançait `runEquipmentAutoLink` sans l'attendre, la
 * modification un `void import(...)` : un redémarrage, une erreur ou une
 * coupure perdaient le rapprochement, sans trace ni reprise ; un changement
 * de marque, de modèle ou de n° de série ne relançait rien.
 *
 * MAINTENANT : la demande est ENREGISTRÉE dans la file durable existante
 * (`ai_job_queue`, traitement T3, sorte `equipment_documents`, une cible
 * par équipement) — mise en file ATTENDUE par l'appelant :
 *   · reprise après interruption ou échec (bail, tentatives, backoff) ;
 *   · idempotence et absence de doublons (clé de déduplication par
 *     équipement, événements fusionnés `append_events`) ; l'exécution relit
 *     l'état courant et le service commun n'écrit que ce qui manque ;
 *   · observable (écran File IA du BO, résultat métier détaillé, erreurs
 *     journalisées par la file).
 * Déclencheurs, seulement sur un changement EFFECTIF : création, nom ou bien
 * parent modifiés (routes), marque / modèle / n° de série modifiés (écrivain
 * canonique de l'équipement, toutes origines).
 *
 * EXÉCUTION : création → `runEquipmentAutoLink` (documents, agenda,
 * fournisseurs ; T3 seulement pour les vraies ambiguïtés) ; modification →
 * documents seuls, DÉTERMINISTE (aucun appel IA), ambiguïtés en carte
 * LINK-ELT. Équipement archivé ou hors du compte : TARGET_GONE.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { QueuedJob } from '@/services/ai/queue/job-queue.repository';
import type { ExecutionGuard } from '@/services/ai/queue/execution-control';
import { PermanentJobError, type JobBusinessResult } from '@/services/ai/queue/queue-policy';
import { buildT3Payload, parseTargetId, registerT3JobKind } from '@/services/ai/reconciliation/t3-job-contract';

export const EQUIPMENT_DOCUMENTS_KIND = 'equipment_documents';
export const T3_TARGET_EQUIPMENT_DOCUMENTS = 'equipment_documents';
/** Regroupe une rafale de modifications d'un même équipement (secondes). */
export const EQUIPMENT_DOCUMENTS_DELAY_SECONDS = 5;

export type EquipmentDocumentsReason = 'created' | 'renamed' | 'moved' | 'identifiers_changed';
const REASONS: ReadonlySet<string> = new Set(['created', 'renamed', 'moved', 'identifiers_changed']);

export interface EquipmentDocumentsEvent {
  reason: EquipmentDocumentsReason;
  /** Clés modifiées (marque, modèle, n° de série…), pour le diagnostic. */
  keys?: string[];
  at?: string;
}

export interface EquipmentDocumentsPayload {
  kind: typeof EQUIPMENT_DOCUMENTS_KIND;
  equipmentId: number;
  events: EquipmentDocumentsEvent[];
  requestedAt: string | null;
}

export interface EquipmentDocumentsQueueDeps {
  enqueue: typeof import('@/services/ai/queue/job-queue.repository').enqueue;
}

/**
 * Met en file (durable) le rapprochement des documents d'un équipement.
 * Rend l'identifiant du travail (créé ou vivant qui absorbe la demande).
 * LÈVE si la file est indisponible : l'appelant décide du repli.
 */
export async function requestEquipmentDocumentSync(
  accountId: number, equipmentId: number, event: { reason: EquipmentDocumentsReason; keys?: string[] },
  deps?: EquipmentDocumentsQueueDeps, now: Date = new Date(),
): Promise<number | null> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !Number.isSafeInteger(equipmentId) || equipmentId <= 0) return null;
  const enqueue = deps?.enqueue ?? (await import('@/services/ai/queue/job-queue.repository')).enqueue;
  const e: EquipmentDocumentsEvent = { reason: event.reason, ...(event.keys?.length ? { keys: [...new Set(event.keys)] } : {}), at: now.toISOString() };
  const { jobId } = await enqueue({
    treatment: 'T3',
    scope: { accountId, targetType: T3_TARGET_EQUIPMENT_DOCUMENTS, targetId: String(equipmentId) },
    triggerCode: null,
    payload: buildT3Payload(EQUIPMENT_DOCUMENTS_KIND, { events: [e] }, now),
    payloadOnDedupe: 'append_events',
    delaySeconds: EQUIPMENT_DOCUMENTS_DELAY_SECONDS,
  });
  return jobId;
}

/** Variante non bloquante (écrivain canonique) : journalise l'échec, ne lève jamais. */
export async function notifyEquipmentIdentifiersChanged(accountId: number, equipmentId: number, keys: string[]): Promise<void> {
  try {
    await requestEquipmentDocumentSync(accountId, equipmentId, { reason: 'identifiers_changed', keys });
  } catch (e) {
    console.error(`[equipment-documents] mise en file impossible (compte ${accountId}, équipement ${equipmentId}) :`, (e as Error).message);
  }
}

function parseEvents(job: Pick<QueuedJob, 'id'>, raw: unknown): EquipmentDocumentsEvent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PermanentJobError(`T3 job ${job.id} : events n'est pas une liste`);
  return raw.map((x) => {
    if (typeof x !== 'object' || x === null || !REASONS.has(String((x as { reason?: unknown }).reason))) {
      throw new PermanentJobError(`T3 job ${job.id} : événement équipement malformé`);
    }
    const o = x as Record<string, unknown>;
    return {
      reason: o.reason as EquipmentDocumentsReason,
      ...(Array.isArray(o.keys) ? { keys: o.keys.filter((k): k is string => typeof k === 'string') } : {}),
      ...(typeof o.at === 'string' ? { at: o.at } : {}),
    };
  });
}

/** Exécutant de la sorte `equipment_documents` (relit l'état courant ; rejouable). */
export async function runEquipmentDocumentsJob(job: QueuedJob, p: EquipmentDocumentsPayload, guard: ExecutionGuard): Promise<JobBusinessResult> {
  const accountId = Number(job.accountId);
  const { pgClient } = await import('@/db');
  const [eq] = (await pgClient.unsafe(
    `SELECT e.id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
      WHERE e.id = $2 AND e.archived_at IS NULL`,
    [accountId, p.equipmentId] as never[],
  )) as unknown as unknown[];
  if (!eq) return { result: 'TARGET_GONE', detail: { equipmentId: p.equipmentId } };
  const reasons = [...new Set(p.events.map((e) => e.reason))];
  const creation = reasons.includes('created');
  const detail: Record<string, unknown> = { equipmentId: p.equipmentId, reasons, aiAllowed: creation };
  if (creation) {
    const { runEquipmentAutoLink } = await import('./equipment-auto-link.service');
    const r = await runEquipmentAutoLink(p.equipmentId, accountId, { guard });
    Object.assign(detail, { documents: r.documentSync, agendaLinked: r.applied.agendaLinked, suppliersLinked: r.applied.suppliersLinked });
    const changes = (r.documentSync?.created ?? 0) + r.applied.agendaLinked + r.applied.suppliersLinked + (r.documentSync?.cardsProposed ?? 0);
    return { result: changes > 0 ? 'APPLIED' : 'NO_CHANGE', detail };
  }
  const { syncEquipmentDocumentLinks } = await import('./document-equipment-link.service');
  const r = await syncEquipmentDocumentLinks({ accountId, equipmentId: p.equipmentId, allowAi: false, proposeCards: true, guard });
  Object.assign(detail, { documents: r });
  return { result: r.created + r.cardsProposed > 0 ? 'APPLIED' : 'NO_CHANGE', detail };
}

/** Enregistre la sorte de travail (réentrant). */
export function registerEquipmentDocumentsT3(): void {
  registerT3JobKind<EquipmentDocumentsPayload>({
    kind: EQUIPMENT_DOCUMENTS_KIND,
    targetTypes: [T3_TARGET_EQUIPMENT_DOCUMENTS],
    account: 'required',
    versions: [1],
    parse(raw, job) {
      return {
        kind: EQUIPMENT_DOCUMENTS_KIND, equipmentId: parseTargetId(job), events: parseEvents(job, raw.events),
        requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : null,
      };
    },
    run: ({ job, payload, guard }) => runEquipmentDocumentsJob(job, payload, guard),
  });
}
