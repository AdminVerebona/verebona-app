/**
 * Lectures des sources AGENDA (lot 47B, point 1) — dans la transaction de
 * l'écriture Opération (verrou du compte détenu). Aucune écriture ici.
 */
import { sql, type SQL } from 'drizzle-orm';
import { agendaFunctionalColumnsReady } from '@/services/agenda/agenda-columns';
import type { DbTx } from '../lock';
import type { BusinessOperationStatus } from '../model';
import { PROJECTION_ORIGIN } from '../agenda-projection/model';
import type { AgendaMatchOperation, AgendaSourceItem } from './agenda-source';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isSafeInteger(x)) : []);
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;

/**
 * Élément d'agenda du compte, lu comme source (null : supprimé ou d'un autre
 * compte). Biens / équipements VIVANTS seulement ; `business_operation_id`
 * résolu vers la canonique d'une fusion.
 */
export async function loadAgendaSourceItem(tx: DbTx, accountId: number, itemId: number): Promise<AgendaSourceItem | null> {
  const col = await agendaFunctionalColumnsReady();
  const [r] = await rows(tx, sql`
    SELECT i.id, i.account_id, i.title, i.description, i.start_date::text AS date, i.end_date::text AS end_date, i.manual_status,
           i.is_automatic, i.is_automatic_modified,
           (i.projection_origin IS NOT DISTINCT FROM ${PROJECTION_ORIGIN}) AS projected,
           COALESCE(o.merged_into_operation_id, o.id) AS op,
           ${col ? sql`i.event_nature` : sql`NULL::text`} AS nature, ${col ? sql`i.business_type` : sql`NULL::text`} AS business_type,
           (SELECT e.event_type = 'STATUS_CHANGED' FROM agenda_occurrence_events e
             WHERE e.agenda_item_id = i.id AND e.event_type IN ('STATUS_CHANGED', 'STATUS_AUTO_COMPLETED')
             ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS status_by_user,
           COALESCE((SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM agenda_asset_links l
                       JOIN assets a ON a.id = l.asset_id AND a.account_id = i.account_id AND a.deleted_at IS NULL
                      WHERE l.agenda_item_id = i.id), '{}') AS asset_ids,
           COALESCE((SELECT array_agg(l.equipment_id ORDER BY l.equipment_id) FROM agenda_equipment_links l
                       JOIN equipments e ON e.id = l.equipment_id AND e.archived_at IS NULL
                       JOIN assets a ON a.id = e.asset_id AND a.account_id = i.account_id AND a.deleted_at IS NULL
                      WHERE l.agenda_item_id = i.id), '{}') AS equipment_ids,
           COALESCE((SELECT array_agg(DISTINCT f) FROM (
                       SELECT l.asset_file_id AS f FROM agenda_file_links l WHERE l.agenda_item_id = i.id
                       UNION SELECT i.origin_ref_id WHERE i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL) x), '{}') AS file_ids
      FROM agenda_items i
      LEFT JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = i.account_id
     WHERE i.id = ${itemId} AND i.account_id = ${accountId}`);
  if (!r) return null;
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    title: String(r.title ?? ''),
    description: txt(r.description),
    date: txt(r.date),
    endDate: txt(r.end_date),
    manualStatus: txt(r.manual_status)?.trim() || null,
    isAutomatic: r.is_automatic === true,
    isAutomaticModified: r.is_automatic_modified === true,
    projected: r.projected === true,
    statusByUser: r.status_by_user === true,
    businessOperationId: r.op === null || r.op === undefined ? null : Number(r.op),
    nature: txt(r.nature),
    businessType: txt(r.business_type),
    assetIds: nums(r.asset_ids),
    equipmentIds: nums(r.equipment_ids),
    fileIds: nums(r.file_ids),
  };
}

/** Sources AGENDA gérées (locator.agenda) d'un élément, actives ou non. */
export async function loadAgendaSources(tx: DbTx, accountId: number, itemId: number): Promise<Array<{
  id: number; operationId: number; active: boolean; opActive: boolean;
}>> {
  const r = await rows(tx, sql`
    SELECT s.id, s.operation_id, s.active,
           (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS op_active
      FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
     WHERE s.account_id = ${accountId} AND s.source_kind = 'AGENDA' AND s.source_entity_key = ${String(itemId)}
       AND s.locator ? 'agenda'
     ORDER BY s.id`);
  return r.map((x) => ({ id: Number(x.id), operationId: Number(x.operation_id), active: x.active === true, opActive: x.op_active === true }));
}

/**
 * Opérations INTERVENTION (ou de type nul) ACTIVES du compte qui pourraient
 * représenter l'élément : mêmes biens, ou document lié qui les prouve.
 * Bornée (NFR-OP-010).
 */
export async function loadAgendaMatchOperations(
  tx: DbTx, accountId: number, item: Pick<AgendaSourceItem, 'id' | 'assetIds' | 'fileIds'>,
): Promise<AgendaMatchOperation[]> {
  if (!item.assetIds.length && !item.fileIds.length) return [];
  const r = await rows(tx, sql`
    SELECT o.id, o.status, o.planned_date::text AS planned_date, o.realized_date::text AS realized_date, o.technical_label,
           COALESCE((SELECT array_agg(l.asset_id) FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active), '{}') AS asset_ids,
           COALESCE((SELECT array_agg(DISTINCT (s.source_entity_key)::int) FROM business_operation_sources s
                      WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]{1,9}$'), '{}') AS file_ids,
           EXISTS (SELECT 1 FROM agenda_items ai
                    WHERE ai.business_operation_id = o.id AND ai.account_id = o.account_id AND ai.id <> ${item.id}
                      AND (NOT ai.is_automatic OR ai.is_automatic_modified OR COALESCE(trim(ai.manual_status), '') <> '')) AS other_user_item
      FROM business_operations o
     WHERE o.account_id = ${accountId} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       AND (o.type_code = 'INTERVENTION' OR o.type_code IS NULL)
       AND (EXISTS (SELECT 1 FROM business_operation_asset_links l
                     WHERE l.operation_id = o.id AND l.active AND l.asset_id = ANY(${intArray(item.assetIds)}::int[]))
            OR EXISTS (SELECT 1 FROM business_operation_sources s
                        WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'
                          AND s.source_entity_key = ANY(${`{${item.fileIds.map(String).join(',')}}`}::text[])))
     ORDER BY o.id DESC
     LIMIT 300`);
  return r.map((x) => ({
    id: Number(x.id),
    status: String(x.status) as BusinessOperationStatus,
    plannedDate: txt(x.planned_date),
    realizedDate: txt(x.realized_date),
    technicalLabel: txt(x.technical_label),
    assetIds: nums(x.asset_ids),
    documentFileIds: nums(x.file_ids),
    hasOtherUserItem: x.other_user_item === true,
  }));
}
