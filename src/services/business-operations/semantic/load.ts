/**
 * Lot 87B (CODE-01) — LECTURES du contexte d'une réévaluation T4 (aucune
 * écriture). Le constructeur pur est `context.ts`.
 *
 * Éléments À DÉCIDER (sélection de candidats, CODE-04 — signaux, jamais
 * décision) : tous les éléments liés à l'Opération ; les éléments
 * automatiques produits depuis un de ses documents (origine) qui ne sont pas
 * liés à une autre Opération active ; les candidats fournis par l'appelant
 * (projection : rapprochement incertain). Éléments de CONTEXTE : ceux des
 * Opérations voisines (biens communs, période proche). Restaurables : lignes
 * ABSORB non restaurées du journal 0591 de l'Opération (lot 76H).
 */
import type postgres from 'postgres';
import type { ContextAmount, ContextPriorDecision, ContextReference } from './contract';
import type { RawContext, RawDocument, RawItem, RawOperation, RawRestorable, RawUserDecisions } from './context';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;

const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isSafeInteger(x)) : []);
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** Fenêtre des voisines (jours) autour de la date de l'Opération. */
const NEIGHBOUR_WINDOW_DAYS = 180;
const NEIGHBOURS_READ = 8;
const CONTEXT_ITEMS_READ = 40;
const SCOPE_ITEMS_READ = 40;

async function journalPresent(sql: Sql, table: string): Promise<boolean> {
  const [r] = await sql.unsafe<Row[]>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table] as never[]);
  return r?.ok === true;
}

async function loadOperations(sql: Sql, accountId: number, ids: readonly number[]): Promise<RawOperation[]> {
  if (!ids.length) return [];
  const r = await sql.unsafe<Row[]>(`
    SELECT o.id, o.type_code, o.status, o.technical_label, o.provider,
           o.planned_date::text AS planned_date, o.start_date::text AS start_date, o.realized_date::text AS realized_date, o.end_date::text AS end_date,
           (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active,
           COALESCE((SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active), '{}') AS asset_ids,
           COALESCE((SELECT array_agg(DISTINCT l.equipment_id) FROM business_operation_equipment_links l WHERE l.operation_id = o.id AND l.active), '{}') AS equipment_ids,
           COALESCE((SELECT array_agg(DISTINCT l.substructure_id) FROM business_operation_room_links l WHERE l.operation_id = o.id AND l.active), '{}') AS room_ids,
           COALESCE((SELECT array_agg(DISTINCT f.id ORDER BY f.id) FROM business_operation_sources s
                       JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = o.account_id AND f.deleted_at IS NULL
                      WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'), '{}') AS file_ids,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', c.kind, 'amountMinor', c.amount_minor, 'currency', c.currency,
                        'date', c.economic_date::text, 'periodStart', c.period_start::text, 'periodEnd', c.period_end::text) ORDER BY c.id)
                       FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.active), '[]') AS amounts,
           COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('kind', x.reference_kind, 'value', x.reference_value))
                       FROM business_operation_references x WHERE x.operation_id = o.id AND x.active), '[]') AS refs
      FROM business_operations o WHERE o.account_id = $1 AND o.id = ANY($2::bigint[]) ORDER BY o.id`, [accountId, intArray(ids)] as never[]);
  return r.map((x) => ({
    id: Number(x.id), typeCode: txt(x.type_code), status: String(x.status), label: txt(x.technical_label), provider: txt(x.provider),
    plannedDate: txt(x.planned_date), startDate: txt(x.start_date), realizedDate: txt(x.realized_date), endDate: txt(x.end_date),
    active: x.active === true, assetIds: nums(x.asset_ids), equipmentIds: nums(x.equipment_ids), roomIds: nums(x.room_ids), fileIds: nums(x.file_ids),
    amounts: ((x.amounts as ContextAmount[]) ?? []).slice(0, 20).map((a) => ({ ...a, amountMinor: Number(a.amountMinor) })),
    references: ((x.refs as ContextReference[]) ?? []).slice(0, 20),
  }));
}

const ITEM_COLUMNS = (journal: boolean) => `
  i.id, i.title, i.start_date::text AS date, i.event_nature, i.business_type, i.is_automatic, COALESCE(i.is_automatic_modified, false) AS modified,
  NULLIF(i.manual_status, '') AS manual_status,
  (COALESCE(i.requires_qualification, false) OR i.occurrence_nature IS NOT DISTINCT FROM 'FORECAST') AS pending,
  (i.confirmation_mode IS NOT DISTINCT FROM 'USER') AS confirmed,
  (i.projection_origin IS NOT DISTINCT FROM 'OPERATION') AS projected,
  i.business_operation_id, (lo.id IS NOT NULL AND lo.invalidated_at IS NULL AND lo.merged_into_operation_id IS NULL) AS op_active,
  i.operation_role, i.operation_role_origin,
  COALESCE((SELECT array_agg(l.asset_file_id ORDER BY l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = i.id), '{}') AS file_ids,
  CASE WHEN i.origin_ref_type = 'asset_file' THEN i.origin_ref_id END AS origin_file_id,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('fileId', s.asset_file_id, 'role', s.source_role) ORDER BY s.id) FROM agenda_item_sources s WHERE s.agenda_item_id = i.id), '[]') AS sources,
  COALESCE((SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = i.id), '{}') AS asset_ids,
  ${journal ? `EXISTS (SELECT 1 FROM agenda_intervention_consolidations k WHERE k.account_id = i.account_id AND k.restored_at IS NOT NULL
                 AND (k.absorbed_item_id = i.id OR (k.kind <> 'ABSORB' AND k.principal_item_id = i.id)))` : 'false'} AS restored`;

function toItem(x: Row): RawItem {
  return {
    id: Number(x.id), title: String(x.title ?? ''), date: txt(x.date), nature: txt(x.event_nature), businessType: txt(x.business_type),
    isAutomatic: x.is_automatic === true, isAutomaticModified: x.modified === true, manualStatus: txt(x.manual_status),
    pendingStatus: x.pending === true || x.restored === true, confirmedByUser: x.confirmed === true, projected: x.projected === true,
    operationId: x.business_operation_id == null ? null : Number(x.business_operation_id), operationActive: x.op_active === true,
    role: (txt(x.operation_role) as RawItem['role']), roleOrigin: txt(x.operation_role_origin),
    fileIds: nums(x.file_ids), originFileId: x.origin_file_id == null ? null : Number(x.origin_file_id),
    sources: ((x.sources as Array<{ fileId: number | null; role: string | null }>) ?? []).map((s) => ({ fileId: s.fileId == null ? null : Number(s.fileId), role: s.role ?? null })),
    assetIds: nums(x.asset_ids), restoredByUser: x.restored === true,
  };
}

/**
 * Sélection des éléments À DÉCIDER pour l'Opération (signaux seulement) :
 * liés ; produits depuis un de ses documents et libres (ou liés à une
 * Opération inactive) ; candidats explicites. Jamais un élément annulé.
 */
async function loadScopeItems(sql: Sql, accountId: number, op: RawOperation, extraItemIds: readonly number[] = []): Promise<RawItem[]> {
  const journal = await journalPresent(sql, 'agenda_intervention_consolidations');
  const r = await sql.unsafe<Row[]>(`
    SELECT ${ITEM_COLUMNS(journal)} FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = $1 AND (i.manual_status IS NULL OR i.manual_status <> 'annule')
       AND (i.business_operation_id = $2
            OR i.id = ANY($4::int[])
            OR (i.origin_ref_type = 'asset_file' AND i.origin_ref_id = ANY($3::int[]) AND i.is_automatic
                AND (i.business_operation_id IS NULL OR lo.id IS NULL OR lo.invalidated_at IS NOT NULL OR lo.merged_into_operation_id IS NOT NULL)))
     ORDER BY i.id LIMIT ${SCOPE_ITEMS_READ}`, [accountId, op.id, intArray(op.fileIds), intArray(extraItemIds)] as never[]);
  return r.map(toItem);
}

async function loadItemsOfOperations(sql: Sql, accountId: number, opIds: readonly number[]): Promise<RawItem[]> {
  if (!opIds.length) return [];
  const journal = await journalPresent(sql, 'agenda_intervention_consolidations');
  const r = await sql.unsafe<Row[]>(`
    SELECT ${ITEM_COLUMNS(journal)} FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = $1 AND i.business_operation_id = ANY($2::bigint[]) AND (i.manual_status IS NULL OR i.manual_status <> 'annule')
     ORDER BY i.id LIMIT ${CONTEXT_ITEMS_READ}`, [accountId, intArray(opIds)] as never[]);
  return r.map(toItem);
}

/** Voisines : Opérations actives d'un bien commun, datées dans la fenêtre (ou sans date), les plus proches d'abord. */
async function loadNeighbourIds(sql: Sql, accountId: number, op: RawOperation): Promise<number[]> {
  if (!op.assetIds.length) return [];
  const ref = op.realizedDate ?? op.plannedDate ?? op.startDate;
  const r = await sql.unsafe<Row[]>(`
    SELECT o.id FROM business_operations o
     WHERE o.account_id = $1 AND o.id <> $2 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       AND EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active AND l.asset_id = ANY($3::int[]))
       AND ($4::date IS NULL OR COALESCE(o.realized_date, o.planned_date, o.start_date) IS NULL
            OR abs(COALESCE(o.realized_date, o.planned_date, o.start_date) - $4::date) <= ${NEIGHBOUR_WINDOW_DAYS})
     ORDER BY CASE WHEN $4::date IS NULL OR COALESCE(o.realized_date, o.planned_date, o.start_date) IS NULL THEN 99999
                   ELSE abs(COALESCE(o.realized_date, o.planned_date, o.start_date) - $4::date) END, o.id
     LIMIT ${NEIGHBOURS_READ}`, [accountId, op.id, intArray(op.assetIds), ref] as never[]);
  return r.map((x) => Number(x.id));
}

async function loadRestorables(sql: Sql, accountId: number, operationId: number): Promise<RawRestorable[]> {
  if (!(await journalPresent(sql, 'agenda_intervention_consolidations'))) return [];
  const r = await sql.unsafe<Row[]>(`
    SELECT k.id, k.absorbed_item_id, k.principal_item_id, k.reason, k.created_at::text AS at, k.detail -> 'item' AS item, k.detail -> 'links' AS links,
           NOT EXISTS (SELECT 1 FROM agenda_items x WHERE x.id = k.absorbed_item_id)
           AND NOT EXISTS (SELECT 1 FROM agenda_items y WHERE y.account_id = k.account_id AND y.functional_key IS NOT NULL
                            AND y.functional_key = k.detail -> 'item' ->> 'functional_key') AS free
      FROM agenda_intervention_consolidations k
     WHERE k.account_id = $1 AND k.operation_id = $2 AND k.kind = 'ABSORB' AND k.restored_at IS NULL AND k.absorbed_item_id IS NOT NULL
     ORDER BY k.id LIMIT 20`, [accountId, operationId] as never[]);
  return r.map((x) => {
    const item = (x.item ?? {}) as Row;
    const links = (x.links ?? {}) as Row;
    return {
      journalId: Number(x.id), absorbedItemId: Number(x.absorbed_item_id), principalItemId: x.principal_item_id == null ? null : Number(x.principal_item_id),
      title: String(item.title ?? ''), date: txt(item.start_date), businessType: txt(item.business_type),
      fileIds: nums(links.files), reason: String(x.reason ?? ''), at: String(x.at ?? ''), restorable: x.free === true,
    };
  });
}

async function loadDocuments(sql: Sql, accountId: number, fileIds: readonly number[]): Promise<RawDocument[]> {
  const ids = [...new Set(fileIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!ids.length) return [];
  const r = await sql.unsafe<Row[]>(`
    SELECT f.id, f.document_type_code, COALESCE(f.retained_title, f.original_filename) AS title, f.document_date::text AS date, f.amount_cents,
           (SELECT c.payload ->> 'provider' FROM document_operation_candidates c WHERE c.account_id = f.account_id AND c.file_id = f.id AND c.status = 'ACTIVE'
             AND c.payload ->> 'provider' IS NOT NULL ORDER BY c.id LIMIT 1) AS provider,
           COALESCE((SELECT jsonb_agg(DISTINCT r) FROM document_operation_candidates c, jsonb_array_elements(
                        CASE WHEN jsonb_typeof(c.payload -> 'businessReferences') = 'array' THEN c.payload -> 'businessReferences' ELSE '[]'::jsonb END) r
                      WHERE c.account_id = f.account_id AND c.file_id = f.id AND c.status = 'ACTIVE'), '[]') AS refs,
           COALESCE((SELECT array_agg(DISTINCT s.operation_id) FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
                      WHERE s.account_id = f.account_id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = f.id::text
                        AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL), '{}') AS op_ids
      FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND f.deleted_at IS NULL ORDER BY f.id`, [accountId, intArray(ids)] as never[]);
  let excerpts = new Map<number, string[]>();
  try {
    const [{ db }, { sourceUnitExcerpts }] = await Promise.all([import('@/db'), import('../consolidation/m3-context')]);
    excerpts = await sourceUnitExcerpts(db as never, accountId, ids);
  } catch (e) {
    console.warn('[semantic] extraits documentaires indisponibles :', (e as Error).message);
  }
  return r.map((x) => ({
    id: Number(x.id), type: txt(x.document_type_code), title: txt(x.title), date: txt(x.date), provider: txt(x.provider),
    amounts: x.amount_cents == null ? [] : [{ kind: 'DOCUMENT_AMOUNT', amountMinor: Number(x.amount_cents), currency: 'EUR', date: txt(x.date), periodStart: null, periodEnd: null }],
    references: ((x.refs as Array<{ kind?: string; value?: string }>) ?? []).filter((y) => y?.kind && y?.value).slice(0, 10).map((y) => ({ kind: String(y.kind), value: String(y.value) })),
    excerpts: excerpts.get(Number(x.id)) ?? [], operationIds: nums(x.op_ids),
  }));
}

async function loadDecisions(sql: Sql, accountId: number, operationId: number, itemIds: readonly number[]): Promise<RawUserDecisions> {
  const d = await sql.unsafe<Row[]>(`
    SELECT source_kind, decision, source_entity_key FROM business_operation_match_decisions
     WHERE account_id = $1 AND active AND candidate_operation_id = $2 AND source_kind IN ('AGENDA', 'PRINCIPAL')`, [accountId, operationId] as never[]);
  const liens = itemIds.length ? await sql.unsafe<Row[]>(`
    SELECT source_entity_key FROM business_operation_match_decisions
     WHERE account_id = $1 AND active AND source_kind = 'AGENDA_FILE_LINK' AND decision = 'REJECTED'
       AND split_part(source_entity_key, ':', 1) = ANY($2::text[])`, [accountId, `{${[...new Set(itemIds)].join(',')}}`] as never[]).catch(() => [] as Row[]) : [];
  const [p] = await sql.unsafe<Row[]>(`
    SELECT id FROM agenda_items WHERE account_id = $1 AND business_operation_id = $2 AND operation_role = 'PRINCIPAL' AND operation_role_origin = 'USER' LIMIT 1`,
  [accountId, operationId] as never[]);
  const s = await sql.unsafe<Row[]>(`
    SELECT projection_key FROM business_operation_projection_suppressions WHERE operation_id = $1 AND account_id = $2 ORDER BY projection_key`,
  [operationId, accountId] as never[]).catch(() => [] as Row[]);
  const parSujet = (kind: string, decision: string) => d.filter((x) => x.source_kind === kind && x.decision === decision)
    .map((x) => Number(String(x.source_entity_key).split(':')[0])).filter((x) => Number.isSafeInteger(x));
  return {
    detachedItemIds: parSujet('AGENDA', 'REJECTED'),
    attachedItemIds: parSujet('AGENDA', 'CONFIRMED'),
    detachedLinks: liens.map((x) => String(x.source_entity_key).split(':').map(Number)).filter((v) => v.length === 2 && v.every(Number.isSafeInteger))
      .map(([itemId, fileId]) => ({ itemId, fileId })),
    principalWithdrawn: d.some((x) => x.source_kind === 'PRINCIPAL' && x.decision === 'REJECTED'),
    userPrincipalItemId: p ? Number(p.id) : null,
    suppressedKeys: s.map((x) => String(x.projection_key)),
  };
}

async function loadPrior(sql: Sql, accountId: number, operationId: number): Promise<ContextPriorDecision[]> {
  if (!(await journalPresent(sql, 'operation_semantic_reevaluations'))) return [];
  const r = await sql.unsafe<Row[]>(`
    SELECT created_at::text AS at, scope, status, COALESCE(reason, '') AS reason FROM operation_semantic_reevaluations
     WHERE account_id = $1 AND operation_id = $2 AND status IN ('APPLIED', 'PARTIAL', 'NO_CHANGE', 'REJECTED', 'ABSTAINED')
     ORDER BY id DESC LIMIT 5`, [accountId, operationId] as never[]);
  return r.map((x) => ({ at: String(x.at), scope: x.scope === 'T3' ? 'T3' : 'T4', status: String(x.status), summary: String(x.reason).slice(0, 200) }));
}

/** Données brutes du contexte (null : Opération introuvable dans le compte). */
export async function loadRepresentationRaw(sql: Sql, accountId: number, operationId: number, opts: { today: string; extraItemIds?: readonly number[] }): Promise<RawContext | null> {
  const [op] = await loadOperations(sql, accountId, [operationId]);
  if (!op) return null;
  const voisinesIds = await loadNeighbourIds(sql, accountId, op);
  const neighbours = await loadOperations(sql, accountId, voisinesIds);
  const scopeItems = await loadScopeItems(sql, accountId, op, opts.extraItemIds ?? []);
  const contextItems = await loadItemsOfOperations(sql, accountId, voisinesIds);
  const restorables = await loadRestorables(sql, accountId, operationId);
  const fichiers = [
    ...op.fileIds, ...scopeItems.flatMap((i) => [...i.fileIds, ...(i.originFileId ? [i.originFileId] : [])]),
    ...restorables.flatMap((r) => r.fileIds), ...neighbours.flatMap((n) => n.fileIds),
  ];
  const documents = await loadDocuments(sql, accountId, fichiers.slice(0, 60));
  const decisions = await loadDecisions(sql, accountId, operationId, scopeItems.map((i) => i.id));
  const prior = await loadPrior(sql, accountId, operationId);
  const noms = await sql.unsafe<Row[]>(`SELECT id, name FROM assets WHERE account_id = $1 AND id = ANY($2::int[])`,
    [accountId, intArray([...op.assetIds, ...neighbours.flatMap((n) => n.assetIds)])] as never[]);
  return {
    today: opts.today, accountId, operation: op, neighbours, scopeItems, contextItems, restorables, documents, decisions, prior,
    assetLabels: new Map(noms.map((x) => [Number(x.id), String(x.name ?? '')]).filter(([, n]) => n) as Array<[number, string]>),
  };
}
