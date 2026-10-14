/**
 * OperationAgendaProjectionService — T4 / Agenda : projection des Opérations
 * (lot 46, O7 ; CDC Opérations V1 ch. 17.1, B16, C16, C16.1, C16.2, C21.1,
 * C22, C24 NFR-OP-006, F-138 à F-147).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIRE, DÉCIDER (règles pures de `model.ts`), ÉCRIRE PAR LA PRIMITIVE AGENDA
 *
 *   projectAccountOperations(compte, { operationIds | all })
 *     relit les Opérations visées, leurs éléments d'agenda liés, les
 *     suppressions mémorisées et le pool de rapprochement, puis applique le
 *     plan de chaque Opération. IDEMPOTENT : un agenda à jour ne produit
 *     aucune écriture (no-op) ; rejouable après un échec (NFR-OP-006 : une
 *     erreur de projection n'annule jamais l'Opération déjà validée).
 *
 * Écritures : `writeAgendaItem` (primitive unique de l'agenda, CDC 15 T4-09)
 * — mêmes colonnes 0223 (clé fonctionnelle, nature, type métier), mêmes
 * liens ; sans recopie « achat » (D-13), sans proposition de statut du bien
 * (D-15 : la donnée vient déjà de la fiche ou des documents), notification
 * seulement pour une échéance à venir (D-14 : un HISTORICAL n'est jamais
 * notifié). Retraits : `removeAgendaItemsTraced` (motif
 * OPERATION_PROJECTION, rattrapable), jamais un élément touché par
 * l'utilisateur.
 *
 * ANTI-BOUCLE (C16.2) : une écriture de projection porte
 * `projection_origin = 'OPERATION'` et la corrélation de la chaîne T3 → T4
 * (`projection_correlation_id`) ; elle n'émet AUCUN déclencheur T3 (seuls
 * les gestes utilisateur de `AgendaWriteService` le font, voir
 * `queue.ts / notifyAgendaChangedForOperations`).
 *
 * SUPPRESSION UTILISATEUR (C16.1, F-146) : `recordAgendaProjectionSuppression`
 * écrit `business_operation_projection_suppressions` dans la transaction de
 * suppression de l'élément ; la projection la consulte avant toute création
 * ou tout rapprochement. Changement significatif qui rouvre la projection :
 * une NOUVELLE clé de projection (type requalifié, nouvelle échéance de
 * contrat) — jamais une simple reconsolidation ni le balayage horaire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { agendaFunctionalColumnsReady } from '@/services/agenda/agenda-columns';
import { writeAgendaItem, type AgendaItemValues } from '@/services/agenda/write-agenda-item';
import {
  COMPATIBLE_BUSINESS_TYPES, PROJECTION_KIND_AGENDA, PROJECTION_ORIGIN, PROJECTION_ORIGIN_REF_TYPE, PROJECTION_ORIGIN_TYPE,
  MATCH_DATE_TOLERANCE_DAYS, decideProjection, isTouched, parseProjectionFunctionalKey, planOperationProjection, projectionKeyOf,
  type AgendaItemSnapshot, type ItemSync, type OperationSnapshot, type ProjectionAction,
} from './model';
import type { AgendaEventNature } from '@/services/agenda/agenda-functional-key';
import type { BusinessOperationStatus, BusinessOperationTypeCode } from '../model';

type Row = Record<string, unknown>;
interface Executor { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(x: Executor, q: SQL): Promise<T[]> => (await x.execute(q)) as unknown as T[];
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isSafeInteger(x)) : []);
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Pool de rapprochement borné par passage (charge). */
const CANDIDATE_LIMIT = 2000;
/**
 * Lot 54D (E07) : taille des PAGES d'un passage complet (curseur stable sur
 * l'identifiant) — le passage va jusqu'à épuisement du périmètre, plus de
 * plafond à 1 000 Opérations.
 */
export const PROJECTION_PAGE_SIZE = 500;

export interface ProjectionRunOptions {
  /** Opérations à projeter (identifiants, fusionnées comprises : la canonique est traitée). */
  operationIds?: readonly number[];
  /** Toutes les Opérations du compte, plus le nettoyage des projections orphelines. */
  all?: boolean;
  /** Corrélation de la chaîne T3 → T4 (C16.2). */
  correlationId?: string | null;
  today?: string;
  /** Garde du travail de file, appelée avant chaque écriture. */
  beforeWrite?: (what: string) => Promise<void> | void;
  /**
   * Lot 53 (D14) : réalités pour lesquelles l'utilisateur a choisi « ajouter
   * un nouvel événement » (carte de rapprochement) — création sans nouveau
   * rapprochement.
   */
  forceCreateOperationIds?: readonly number[];
  /** Tests : taille de page d'un passage complet (E07). */
  pageSize?: number;
}

export interface ProjectionRunResult {
  operations: number;
  created: number;
  updated: number;
  linked: number;
  removed: number;
  detached: number;
  markedDone: number;
  proposed: number;
  abstained: number;
  suppressed: number;
  /** Lot 53 (D14) : cartes « À traiter » de rapprochement incertain posées / mises à jour. */
  matchCards?: number;
  /** Lot 54D (E07) : pages traitées (passage complet), dernier identifiant atteint. */
  pages?: number;
  lastOperationId?: number | null;
  /** Écritures effectives (0 = no-op). */
  changes: number;
  skipped?: 'COLUMNS_MISSING';
}

const vide = (): ProjectionRunResult => ({
  operations: 0, created: 0, updated: 0, linked: 0, removed: 0, detached: 0, markedDone: 0, proposed: 0, abstained: 0, suppressed: 0, changes: 0,
});

// ── Lectures ────────────────────────────────────────────────────────────────

async function canonicalIds(accountId: number, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  const r = await rows<{ id: string }>(db, sql`
    WITH RECURSIVE chaine(id, merged) AS (
      SELECT o.id, o.merged_into_operation_id FROM business_operations o
       WHERE o.account_id = ${accountId} AND o.id = ANY(${intArray(ids)}::bigint[])
      UNION
      SELECT o.id, o.merged_into_operation_id FROM business_operations o JOIN chaine c ON o.id = c.merged
       WHERE o.account_id = ${accountId}
    )
    SELECT DISTINCT id FROM chaine`);
  return r.map((x) => Number(x.id));
}

async function projectableIdsPage(accountId: number, afterId: number, size: number): Promise<number[]> {
  const r = await rows<{ id: string }>(db, sql`
    SELECT o.id FROM business_operations o
     WHERE o.account_id = ${accountId} AND o.id > ${afterId}
       AND ((o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
             AND o.type_code IN ('INTERVENTION', 'CLAIM', 'ACQUISITION', 'DISPOSAL', 'CONTRACT'))
            OR EXISTS (SELECT 1 FROM agenda_items ai WHERE ai.business_operation_id = o.id AND ai.account_id = o.account_id))
     ORDER BY o.id
     LIMIT ${size}`);
  return r.map((x) => Number(x.id));
}

export async function loadOperationSnapshots(accountId: number, ids: readonly number[]): Promise<OperationSnapshot[]> {
  if (!ids.length) return [];
  const r = await rows(db, sql`
    SELECT o.id, o.account_id, o.type_code, o.status, o.technical_label, o.provider,
           o.planned_date::text AS planned_date, o.realized_date::text AS realized_date, o.end_date::text AS end_date,
           (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active,
           COALESCE((SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM business_operation_asset_links l
                       JOIN assets a ON a.id = l.asset_id AND a.account_id = o.account_id AND a.deleted_at IS NULL
                      WHERE l.operation_id = o.id AND l.active), '{}') AS asset_ids,
           COALESCE((SELECT array_agg(DISTINCT l.equipment_id) FROM business_operation_equipment_links l
                      WHERE l.operation_id = o.id AND l.active), '{}') AS equipment_ids,
           COALESCE((SELECT array_agg(DISTINCT f.id) FROM business_operation_sources s
                       JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = o.account_id AND f.deleted_at IS NULL
                      WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'), '{}') AS file_ids,
           cd.effective_to::text AS contract_effective_to,
           kd.history_event_id AS claim_history_event_id,
           (SELECT a.status FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id
             WHERE l.operation_id = o.id AND l.active ORDER BY (l.link_role = 'PRIMARY') DESC, l.asset_id LIMIT 1) AS primary_asset_status
      FROM business_operations o
      LEFT JOIN business_operation_contract_details cd ON cd.operation_id = o.id
      LEFT JOIN business_operation_claim_details kd ON kd.operation_id = o.id
     WHERE o.account_id = ${accountId} AND o.id = ANY(${intArray(ids)}::bigint[])
     ORDER BY o.id`);
  return r.map((x): OperationSnapshot => ({
    id: Number(x.id),
    accountId: Number(x.account_id),
    typeCode: (txt(x.type_code) as BusinessOperationTypeCode | null),
    status: String(x.status) as BusinessOperationStatus,
    technicalLabel: txt(x.technical_label),
    provider: txt(x.provider),
    plannedDate: txt(x.planned_date),
    realizedDate: txt(x.realized_date),
    endDate: txt(x.end_date),
    active: x.active === true,
    assetIds: nums(x.asset_ids),
    equipmentIds: nums(x.equipment_ids),
    documentFileIds: nums(x.file_ids).sort((a, b) => a - b),
    contractEffectiveTo: txt(x.contract_effective_to),
    claimHistoryEventId: x.claim_history_event_id === null || x.claim_history_event_id === undefined ? null : Number(x.claim_history_event_id),
    disposalKind: x.primary_asset_status === 'TRANSMIS' ? 'TRANSMISSION' : 'SALE',
  }));
}

const ITEM_COLUMNS = sql.raw(`
  i.id, i.title, i.start_date::text AS date, i.manual_status, i.is_automatic, i.is_automatic_modified,
  (i.projection_origin IS NOT DISTINCT FROM '${PROJECTION_ORIGIN}') AS projected, i.business_operation_id,
  (lo.id IS NOT NULL AND lo.invalidated_at IS NULL AND lo.merged_into_operation_id IS NULL) AS linked_active,
  i.event_nature, i.business_type, i.home_category, i.functional_key, i.origin_ref_type, i.origin_ref_id,
  COALESCE((SELECT array_agg(l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = i.id), '{}') AS asset_ids,
  COALESCE((SELECT array_agg(l.equipment_id) FROM agenda_equipment_links l WHERE l.agenda_item_id = i.id), '{}') AS equipment_ids,
  COALESCE((SELECT array_agg(l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = i.id), '{}') AS file_ids`);

function toItem(x: Row): AgendaItemSnapshot {
  return {
    id: Number(x.id),
    title: String(x.title ?? ''),
    date: txt(x.date),
    manualStatus: txt(x.manual_status) || null,
    isAutomatic: x.is_automatic === true,
    isAutomaticModified: x.is_automatic_modified === true,
    projected: x.projected === true,
    businessOperationId: x.business_operation_id === null || x.business_operation_id === undefined ? null : Number(x.business_operation_id),
    linkedOperationActive: x.linked_active === true,
    nature: (txt(x.event_nature) as AgendaEventNature | null),
    businessType: txt(x.business_type),
    homeCategory: txt(x.home_category),
    functionalKey: txt(x.functional_key),
    originRefType: txt(x.origin_ref_type),
    originRefId: x.origin_ref_id === null || x.origin_ref_id === undefined ? null : Number(x.origin_ref_id),
    assetIds: nums(x.asset_ids),
    equipmentIds: nums(x.equipment_ids),
    fileIds: nums(x.file_ids),
  };
}

async function loadLinkedItems(accountId: number, opIds: readonly number[]): Promise<AgendaItemSnapshot[]> {
  if (!opIds.length) return [];
  return (await rows(db, sql`
    SELECT ${ITEM_COLUMNS} FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = ${accountId} AND i.business_operation_id = ANY(${intArray(opIds)}::bigint[])
     ORDER BY i.id`)).map(toItem);
}

async function loadCandidates(accountId: number, assetIds: readonly number[], fileIds: readonly number[]): Promise<AgendaItemSnapshot[]> {
  if (!assetIds.length && !fileIds.length) return [];
  return (await rows(db, sql`
    SELECT ${ITEM_COLUMNS} FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = ${accountId} AND i.start_date IS NOT NULL
       AND (i.manual_status IS NULL OR i.manual_status <> 'annule')
       AND (EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = ANY(${intArray(assetIds)}::int[]))
            OR EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND l.asset_file_id = ANY(${intArray(fileIds)}::int[]))
            OR (i.origin_ref_type = 'asset_file' AND i.origin_ref_id = ANY(${intArray(fileIds)}::int[])))
     ORDER BY i.id DESC
     LIMIT ${CANDIDATE_LIMIT}`)).map(toItem);
}

async function loadSuppressions(opIds: readonly number[]): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  if (!opIds.length) return out;
  const r = await rows<{ operation_id: string; projection_key: string }>(db, sql`
    SELECT operation_id, projection_key FROM business_operation_projection_suppressions
     WHERE operation_id = ANY(${intArray(opIds)}::bigint[]) AND projection_kind = ${PROJECTION_KIND_AGENDA}`);
  for (const x of r) {
    const id = Number(x.operation_id);
    if (!out.has(id)) out.set(id, new Set());
    out.get(id)!.add(x.projection_key);
  }
  return out;
}

async function loadStatusCardItems(accountId: number, itemIds: readonly number[]): Promise<Set<number>> {
  if (!itemIds.length) return new Set();
  const r = await rows<{ target_id: number }>(db, sql`
    SELECT DISTINCT target_id FROM to_process_actions
     WHERE account_id = ${accountId} AND target_type = 'AGENDA_ITEM' AND field_key = 'manualStatus'
       AND target_id = ANY(${intArray(itemIds)}::int[])`);
  return new Set(r.map((x) => Number(x.target_id)));
}

// ── Écritures ───────────────────────────────────────────────────────────────

async function itemIdByKey(accountId: number, key: string): Promise<number | null> {
  const [r] = await rows<{ id: number }>(db, sql`
    SELECT id FROM agenda_items WHERE account_id = ${accountId} AND functional_key = ${key} AND is_automatic LIMIT 1`);
  return r ? Number(r.id) : null;
}

function syncValues(changes: ItemSync, correlationId: string | null): Partial<AgendaItemValues> {
  return {
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.date !== undefined ? { startDate: changes.date } : {}),
    ...(changes.homeCategory !== undefined ? { homeCategory: changes.homeCategory } : {}),
    ...(changes.manualStatus !== undefined ? { manualStatus: changes.manualStatus } : {}),
    ...(changes.businessOperationId !== undefined ? { businessOperationId: changes.businessOperationId, originRefId: changes.businessOperationId } : {}),
    projectionOrigin: PROJECTION_ORIGIN,
    projectionCorrelationId: correlationId,
    updatedAt: new Date(),
  };
}

async function applyAction(
  op: OperationSnapshot, a: ProjectionAction, res: ProjectionRunResult, opts: Required<Pick<ProjectionRunOptions, 'beforeWrite'>> & { correlationId: string | null },
): Promise<number | null> {
  const accountId = op.accountId;
  const garde = (what: string) => opts.beforeWrite(`T4 projection — ${what}`);
  switch (a.kind) {
    case 'CREATE': {
      const d = a.desired;
      await garde('création');
      const values: Partial<AgendaItemValues> = {
        title: d.title, description: null, startDate: d.date, homeCategory: d.category,
        isAutomatic: true, isAutomaticModified: false, requiresQualification: false,
        originType: PROJECTION_ORIGIN_TYPE, originRefType: PROJECTION_ORIGIN_REF_TYPE, originRefId: op.id, originFieldKey: null,
        occurrenceNature: 'CONFIRMED', dateSource: 'EXPLICIT_DATE',
        businessOperationId: op.id, projectionOrigin: PROJECTION_ORIGIN, projectionCorrelationId: opts.correlationId,
      };
      const links = { assetIds: op.assetIds, equipmentIds: op.equipmentIds, fileIds: op.documentFileIds, substructureIds: [] };
      const write = (itemId?: number) => writeAgendaItem({
        ...(itemId !== undefined ? { itemId } : {}),
        values: itemId !== undefined ? { ...values, updatedAt: new Date() } : values,
        links, semantics: { businessType: d.businessType, nature: d.nature }, functionalKey: a.functionalKey,
      }, {
        accountId, channel: 'T4', linkMode: 'replace', notify: itemId === undefined, statusProposal: false,
        ...(itemId !== undefined ? { onlyIfUntouched: true } : {}),
      });
      // Élément de même clé déjà présent (reprise après échec) : adopté.
      const existant = await itemIdByKey(accountId, a.functionalKey);
      try {
        const w = await write(existant ?? undefined);
        if (w.protected) return null;
        if (w.created) res.created++; else res.updated++;
        res.changes++;
        return w.id;
      } catch (e) {
        if (existant === null && /agenda_items_functional_key_uidx/.test(`${(e as Error).message} ${String((e as { cause?: Error }).cause?.message ?? '')}`)) {
          const id = await itemIdByKey(accountId, a.functionalKey);
          if (id !== null) {
            const w = await write(id);
            if (!w.protected) { res.updated++; res.changes++; }
            return w.id;
          }
        }
        throw e;
      }
    }
    case 'SYNC': {
      await garde('mise à jour');
      const c = a.changes;
      const w = await writeAgendaItem({
        itemId: a.itemId,
        values: syncValues(c, opts.correlationId),
        ...(c.links ? { links: { ...c.links, substructureIds: [] } } : {}),
        semantics: { businessType: c.businessType ?? null, nature: c.nature ?? null },
        functionalKey: c.functionalKey ?? null,
      }, { accountId, channel: 'T4', linkMode: 'replace', onlyIfUntouched: true, notify: false, statusProposal: false });
      if (!w.protected) { res.updated++; res.changes++; }
      return null;
    }
    case 'LINK': {
      await garde('rapprochement');
      const r = await rows(db, sql`
        UPDATE agenda_items i SET business_operation_id = ${op.id}, updated_at = now()
         WHERE i.id = ${a.itemId} AND i.account_id = ${accountId}
           AND (i.business_operation_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM business_operations o WHERE o.id = i.business_operation_id
                    AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL))
        RETURNING i.id`);
      if (r.length) { res.linked++; res.changes++; }
      console.info(JSON.stringify({ event: 't4.operation_projection_link', accountId, operationId: op.id, itemId: a.itemId, reason: a.reason, applied: r.length > 0 }));
      return null;
    }
    case 'REMOVE': {
      await garde('retrait');
      const { removeAgendaItemsTraced } = await import('@/services/agenda/agenda-removal-trace');
      const gone = await removeAgendaItemsTraced(pgClient, { accountId, ids: [a.itemId], reason: 'OPERATION_PROJECTION' });
      if (gone.length) { res.removed++; res.changes++; }
      return null;
    }
    case 'DETACH': {
      await garde('détachement');
      await detachItem(accountId, a.itemId);
      res.detached++;
      res.changes++;
      return null;
    }
    case 'MARK_DONE': {
      await garde('statut réalisé');
      const [cur] = await rows<{ s: string | null }>(db, sql`SELECT manual_status AS s FROM agenda_items WHERE id = ${a.itemId} AND account_id = ${accountId}`);
      if (!cur || (cur.s && cur.s !== '')) return null;
      const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
      await upsertAgendaItem({ itemId: a.itemId, accountId, assetId: null, origin: 'AUTOMATIC', details: { manualStatus: 'realise' } });
      const { recordOccurrenceEvent } = await import('@/services/agenda/agenda-persistence');
      await recordOccurrenceEvent(a.itemId, accountId, 'STATUS_AUTO_COMPLETED', {
        manualStatus: 'realise', origin: 'CONSOLIDATED_REALIZATION', reasonCode: 'COMPLETION_PROVEN', correlationId: opts.correlationId,
      });
      const { closeAgendaStatusCards } = await import('@/services/to-process/agenda-status-cards');
      await closeAgendaStatusCards(accountId, a.itemId, 'OBSOLETE');
      res.markedDone++;
      res.changes++;
      return null;
    }
    case 'PROPOSE_DONE': {
      await garde('proposition de réalisation');
      const { proposeAgendaStatus } = await import('@/services/to-process/agenda-status-cards');
      const r = await proposeAgendaStatus({ accountId, itemId: a.itemId, kind: 'propose_done', sourceFileId: op.documentFileIds[0] ?? null });
      if (r.status !== 'SKIPPED') { res.proposed++; res.changes++; }
      return null;
    }
    case 'ABSTAIN':
      res.abstained++;
      if (a.itemId !== undefined) {
        console.info(JSON.stringify({ event: 't4.operation_projection_abstain', accountId, operationId: op.id, itemId: a.itemId, reason: a.reason }));
      }
      return null;
    case 'SUPPRESSED':
      res.suppressed++;
      return null;
  }
}

/** Retire le lien (et le marquage de projection) d'un élément — l'élément reste. */
async function detachItem(accountId: number, itemId: number): Promise<void> {
  await db.execute(sql`
    UPDATE agenda_items
       SET business_operation_id = NULL,
           functional_key = CASE WHEN projection_origin = ${PROJECTION_ORIGIN} THEN NULL ELSE functional_key END,
           projection_origin = NULL, projection_correlation_id = NULL, updated_at = now()
     WHERE id = ${itemId} AND account_id = ${accountId}`);
}

/** Projections orphelines (Opération disparue, lien coupé par un transfert) : retirées, ou détachées si touchées. */
async function cleanupOrphans(accountId: number, res: ProjectionRunResult, beforeWrite: (w: string) => Promise<void> | void): Promise<void> {
  const orphelins = (await rows(db, sql`
    SELECT ${ITEM_COLUMNS} FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = ${accountId} AND i.projection_origin = ${PROJECTION_ORIGIN}
       AND (i.business_operation_id IS NULL OR lo.id IS NULL OR lo.account_id <> i.account_id)`)).map(toItem);
  if (!orphelins.length) return;
  await beforeWrite('T4 projection — orphelines');
  const intacts = orphelins.filter((o) => !isTouched(o)).map((o) => o.id);
  if (intacts.length) {
    const { removeAgendaItemsTraced } = await import('@/services/agenda/agenda-removal-trace');
    const gone = await removeAgendaItemsTraced(pgClient, { accountId, ids: intacts, reason: 'OPERATION_PROJECTION' });
    res.removed += gone.length;
    res.changes += gone.length;
  }
  for (const o of orphelins.filter((x) => isTouched(x))) {
    await detachItem(accountId, o.id);
    res.detached++;
    res.changes++;
  }
}

// ── Point d'entrée ─────────────────────────────────────────────────────────

let signale = false;

/** Projette les Opérations d'un compte dans l'Agenda (voir l'en-tête). Lève sur une erreur technique (rejouable). */
export async function projectAccountOperations(accountId: number, opts: ProjectionRunOptions = {}): Promise<ProjectionRunResult> {
  const res = vide();
  if (!Number.isInteger(accountId) || accountId <= 0) return res;
  if (!(await agendaFunctionalColumnsReady())) {
    if (!signale) {
      signale = true;
      console.error('[t4-projection] colonnes 0223 absentes : projection des Opérations dans l\'agenda suspendue.');
    }
    return { ...res, skipped: 'COLUMNS_MISSING' };
  }
  const beforeWrite = opts.beforeWrite ?? (() => undefined);
  const today = opts.today ?? todayUtc();
  const correlationId = opts.correlationId ?? null;

  if (opts.all) {
    // Lot 54D (E07) : passage COMPLET par pages sur curseur stable, jusqu'à
    // épuisement. Interrompu (garde), le travail est rejoué : les pages déjà
    // projetées n'écrivent plus rien (idempotence), rien n'est omis.
    await cleanupOrphans(accountId, res, beforeWrite);
    res.pages = 0;
    res.lastOperationId = null;
    let curseur = 0;
    for (;;) {
      const page = await projectableIdsPage(accountId, curseur, opts.pageSize ?? PROJECTION_PAGE_SIZE);
      if (!page.length) break;
      await projectIds(accountId, page, res, { ...opts, beforeWrite, today, correlationId });
      res.pages++;
      curseur = page[page.length - 1];
      res.lastOperationId = curseur;
      if (page.length < (opts.pageSize ?? PROJECTION_PAGE_SIZE)) break;
    }
  } else {
    const ids = await canonicalIds(accountId, opts.operationIds ?? []);
    if (!ids.length) return res;
    await projectIds(accountId, ids, res, { ...opts, beforeWrite, today, correlationId });
  }
  if (res.changes > 0) {
    console.info(JSON.stringify({ event: 't4.operation_projection', accountId, correlationId, ...res }));
  }
  return res;
}

/** Projette un lot d'Opérations (identifiants canoniques) — corps commun aux deux modes. */
async function projectIds(
  accountId: number, ids: readonly number[], res: ProjectionRunResult,
  o: ProjectionRunOptions & { beforeWrite: (w: string) => Promise<void> | void; today: string; correlationId: string | null },
): Promise<void> {
  const { beforeWrite, today, correlationId } = o;
  const opts = o;
  const ops = await loadOperationSnapshots(accountId, ids);
  const linked = await loadLinkedItems(accountId, ops.map((o) => o.id));
  const suppressions = await loadSuppressions(ops.map((o) => o.id));
  const actifs = ops.filter((o) => o.active);
  const candidates = await loadCandidates(accountId, actifs.flatMap((o) => o.assetIds), actifs.flatMap((o) => o.documentFileIds));
  const cards = await loadStatusCardItems(accountId, [...linked, ...candidates].map((i) => i.id));
  const taken = new Set<number>(linked.map((i) => i.id));
  const forcer = new Set(opts.forceCreateOperationIds ?? []);
  // Lot 53 (D14) : rapprochements incertains → carte « À traiter » (candidats, provenance).
  const besoins: import('@/services/to-process/agenda-projection-cards').AgendaProjectionCardNeed[] = [];

  for (const op of ops) {
    res.operations++;
    const decision = decideProjection(op, today);
    const plan = planOperationProjection({
      op,
      decision,
      linked: linked.filter((i) => i.businessOperationId === op.id),
      suppressedKeys: suppressions.get(op.id) ?? new Set(),
      candidates,
      taken,
      statusCardItems: cards,
      forceCreate: forcer.has(op.id),
    });
    for (const action of plan) {
      if (action.kind === 'LINK') taken.add(action.itemId);
      if (action.kind === 'ABSTAIN' && action.candidates?.length && action.key && decision.kind === 'PROJECT' && op.assetIds.length) {
        besoins.push({
          operationId: op.id, key: action.key, assetId: op.assetIds[0],
          desired: { title: decision.desired.title, date: decision.desired.date, typeCode: op.typeCode },
          candidates: action.candidates, fileIds: op.documentFileIds,
        });
      }
      const created = await applyAction(op, action, res, { beforeWrite, correlationId });
      if (created !== null) taken.add(created);
    }
  }
  {
    const { syncAgendaProjectionCards } = await import('@/services/to-process/agenda-projection-cards');
    const r = await syncAgendaProjectionCards(accountId, besoins, ops.map((x) => x.id));
    res.matchCards = (res.matchCards ?? 0) + r.created + r.updated;
  }
}

// ── Suppression utilisateur mémorisée (C16.1, F-146) ───────────────────────

/**
 * À appeler DANS la transaction qui supprime l'élément `itemId` à la demande
 * de l'utilisateur. Un élément qui représente une Opération (projeté, ou lié
 * par rapprochement / formulaire Sinistre) : la clé de projection est
 * mémorisée — la projection ne le recréera ni ne liera un autre élément à sa
 * place. Rend l'Opération concernée (ou null). L'Opération n'est jamais
 * invalidée par ce geste (C16.1).
 */
export async function recordAgendaProjectionSuppression(
  tx: Executor, p: { accountId: number; itemId: number; userId: number | null },
): Promise<{ operationId: number; key: string } | null> {
  const [i] = await rows(tx, sql`
    SELECT i.business_operation_id, i.projection_origin, ${await agendaFunctionalColumnsReady() ? sql`i.functional_key` : sql`NULL::text`} AS functional_key,
           o.account_id AS op_account, o.type_code, o.end_date::text AS end_date, cd.effective_to::text AS effective_to
      FROM agenda_items i
      JOIN business_operations o ON o.id = i.business_operation_id
      LEFT JOIN business_operation_contract_details cd ON cd.operation_id = o.id
     WHERE i.id = ${p.itemId} AND i.account_id = ${p.accountId}`);
  if (!i || Number(i.op_account) !== p.accountId) return null;
  const operationId = Number(i.business_operation_id);
  const parsed = i.projection_origin === PROJECTION_ORIGIN ? parseProjectionFunctionalKey(txt(i.functional_key)) : null;
  const key = parsed && parsed.operationId === operationId
    ? parsed.key
    : projectionKeyOf({ typeCode: txt(i.type_code) as BusinessOperationTypeCode | null, contractEffectiveTo: txt(i.effective_to), endDate: txt(i.end_date) });
  if (!key) return null;
  await tx.execute(sql`
    INSERT INTO business_operation_projection_suppressions (account_id, operation_id, projection_kind, projection_key, user_id)
    VALUES (${p.accountId}, ${operationId}, ${PROJECTION_KIND_AGENDA}, ${key}, ${p.userId})
    ON CONFLICT (operation_id, projection_kind, projection_key) DO NOTHING`);
  return { operationId, key };
}

// ── Garde T4 : événement déjà représenté par une Opération ─────────────────

/**
 * Un événement d'agenda lié à une Opération représente-t-il déjà ce que T4
 * s'apprête à créer depuis un document (même bien, date à ±3 jours, même
 * document source de l'Opération ou même type métier compatible) ? Évite le
 * doublon quand la projection est passée AVANT T4 (C16.1, B16 « T4 vérifie
 * toujours l'existence d'un événement lié ou équivalent avant création »).
 * Rend l'élément équivalent, ou null. Ne lève jamais.
 */
export async function findOperationAgendaEquivalent(p: {
  accountId: number; assetId: number; date: string; businessType: string | null; sourceFileId: number | null;
}): Promise<number | null> {
  try {
    if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return null;
    if (!p.sourceFileId && !p.businessType) return null;
    const types = p.businessType
      ? Object.entries(COMPATIBLE_BUSINESS_TYPES).filter(([, bts]) => bts?.includes(p.businessType!)).map(([t]) => t)
      : Object.keys(COMPATIBLE_BUSINESS_TYPES);
    if (!types.length) return null;
    if (!(await agendaFunctionalColumnsReady())) return null;
    const [r] = await rows<{ id: number }>(db, sql`
      SELECT i.id FROM agenda_items i
        JOIN agenda_asset_links l ON l.agenda_item_id = i.id AND l.asset_id = ${p.assetId}
        JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = i.account_id
             AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       WHERE i.account_id = ${p.accountId}
         AND i.start_date BETWEEN (${p.date}::date - ${MATCH_DATE_TOLERANCE_DAYS}::int) AND (${p.date}::date + ${MATCH_DATE_TOLERANCE_DAYS}::int)
         AND o.type_code = ANY(${`{${types.join(',')}}`}::text[])
         AND (${p.sourceFileId ? sql`EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active
                    AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = ${String(p.sourceFileId)})` : sql`FALSE`}
              OR (${p.businessType}::text IS NOT NULL AND i.business_type = ${p.businessType}::text))
       ORDER BY i.id LIMIT 1`);
    return r ? Number(r.id) : null;
  } catch (e) {
    console.error('[t4-projection] contrôle d\'équivalence :', (e as Error).message);
    return null;
  }
}

/**
 * Comptes dont des Opérations n'ont encore aucune représentation d'agenda
 * attendue, ou qui portent des projections orphelines (convergence du
 * balayage horaire, NFR-OP-006 : un événement de bus perdu est rattrapé).
 * Lot 54D (E06) : plus de fenêtre de 48 h — une projection manquante est
 * restaurée QUEL QUE SOIT son âge. Ce qui n'est pas réexaminé : une
 * suppression utilisateur (tombstone `business_operation_projection_
 * suppressions`), un événement déjà lié, et une abstention en attente de
 * l'utilisateur (carte AGENDA-PROJECTION-MATCH ouverte) — aucune boucle :
 * une Opération déjà évaluée sans écriture n'est pas remise en file.
 */
export async function listAccountsNeedingProjection(limit: number): Promise<number[]> {
  if (!(await agendaFunctionalColumnsReady())) return [];
  const r = await rows<{ account_id: number }>(db, sql`
    SELECT account_id FROM (
      SELECT o.account_id FROM business_operations o
       WHERE o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM to_process_actions t
                          WHERE t.account_id = o.account_id AND t.rule_code = 'AGENDA-PROJECTION-MATCH' AND t.resolved_at IS NULL
                            AND t.trigger_context ? 'operationId' AND (t.trigger_context->>'operationId')::bigint = o.id)
         AND ((o.type_code = 'INTERVENTION' AND ((o.status = 'ENVISAGED' AND o.planned_date IS NOT NULL) OR (o.status = 'REALIZED' AND o.realized_date IS NOT NULL)))
              OR (o.type_code IN ('ACQUISITION', 'DISPOSAL') AND o.status = 'REALIZED' AND o.realized_date IS NOT NULL)
              OR (o.type_code = 'CLAIM' AND o.status = 'REALIZED' AND o.realized_date IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM business_operation_claim_details kd WHERE kd.operation_id = o.id AND kd.history_event_id IS NOT NULL))
              OR (o.type_code = 'CONTRACT' AND o.status <> 'CANCELLED'
                  AND EXISTS (SELECT 1 FROM business_operation_contract_details cd WHERE cd.operation_id = o.id AND cd.effective_to >= CURRENT_DATE)))
         AND EXISTS (SELECT 1 FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = o.account_id AND a.deleted_at IS NULL
                      WHERE l.operation_id = o.id AND l.active)
         AND NOT EXISTS (SELECT 1 FROM agenda_items ai WHERE ai.business_operation_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM business_operation_projection_suppressions s WHERE s.operation_id = o.id)
      UNION
      SELECT i.account_id FROM agenda_items i
       WHERE i.projection_origin = ${PROJECTION_ORIGIN}
         AND (i.business_operation_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM business_operations o WHERE o.id = i.business_operation_id AND o.account_id = i.account_id
                  AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL))
    ) x ORDER BY account_id LIMIT ${limit}`);
  return r.map((x) => Number(x.account_id));
}
