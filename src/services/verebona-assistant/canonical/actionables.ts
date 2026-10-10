/**
 * Lectures CANONIQUES des éléments actionnables — lot 34 (ticket T2 « Que
 * dois-je faire aujourd'hui ? »). SQL direct, borné au compte, sans
 * recherche textuelle ni sémantique.
 *
 *   · « À traiter » OUVERTS : `to_process_actions.resolved_at IS NULL` — seul
 *     statut défini par le modèle (une action résolue, non applicable,
 *     obsolète ou dont la cible est supprimée a une date de résolution) ;
 *     cible encore présente (document non supprimé, équipement non archivé,
 *     échéance existante) et bien rattaché DISPONIBLE (règle unique
 *     `asset-availability` : ni supprimé, ni archivé, ni transmis, ni vendu) ;
 *   · ÉCHÉANCES ACTIVES : `agenda_items` ouverts (`manual_status` vide — ni
 *     réalisée, ni annulée), datées, jamais HISTORICAL (D-14, même règle que
 *     `listUpcomingAgenda`), et dont les biens liés ne sont pas tous
 *     indisponibles ; documents associés (liens, sources de l'échéance) lus
 *     comme CONTEXTE.
 *
 * Les éléments du compte sont partagés par ses utilisateurs (Duo compris) :
 * le compte borne toutes les lectures, l'utilisateur n'ajoute aucun filtre
 * (aucune donnée « À traiter » ou agenda n'est propre à un membre).
 */
import { pgClient } from '@/db';
import { agendaFunctionalColumnsReady } from '@/services/agenda/agenda-columns';
import { isAgendaActionItemT4 } from '@/services/home/mascot/collector';
import { assistantAssetAvailability } from '../core/asset-availability';
import type { DeadlineRow, TodoRow } from '../core/actionable-request';
import { HISTORICAL_FIELD_KEYS, NOT_HISTORICAL } from './agenda';
import { DOC_OF_ASSETS } from './repository';

/** Bornes de lecture (au-delà, la page « À traiter » / l'agenda font foi). */
export const MAX_TODO_ROWS = 200;
export const MAX_DEADLINE_ROWS = 300;

export interface ActionableReadOptions {
  /** Biens visés (liens canoniques) ; vide : tout le compte. */
  assetIds?: number[];
  /** Fenêtre des échéances (bornes incluses) ; `null` : sans borne. */
  from: string | null;
  to: string | null;
  todos: boolean;
  deadlines: boolean;
}

type Row = Record<string, unknown>;
const lignes = async (sql: string, params: unknown[]): Promise<Row[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
const isoDate = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/** « À traiter » ouverts du compte (ordre « Par priorité » de la file). */
export async function listOpenTodos(accountId: number, opts: { assetIds?: number[] } = {}): Promise<TodoRow[]> {
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const dispo = assistantAssetAvailability.sql('a');
  const r = await lignes(
    `SELECT t.id, t.question AS title, t.priority, t.action_kind AS "actionKind", t.rule_code AS "ruleCode",
            t.target_type AS "targetType", t.target_id AS "targetId", t.field_key AS "fieldKey",
            to_char(t.due_date AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS "dueDate", t.active_since AS "activeSince",
            a.id AS "assetId", a.name AS "assetName",
            f.id AS "documentId", coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS "documentTitle"
       FROM to_process_actions t
       LEFT JOIN asset_files f ON t.target_type = 'DOCUMENT' AND f.id = t.target_id AND f.account_id = t.account_id
       LEFT JOIN equipments e ON t.target_type = 'EQUIPMENT' AND e.id = t.target_id
       LEFT JOIN agenda_items ai ON t.target_type = 'AGENDA_ITEM' AND ai.id = t.target_id AND ai.account_id = t.account_id
       LEFT JOIN assets a ON a.account_id = t.account_id AND a.id = CASE t.target_type
            WHEN 'ASSET' THEN t.target_id
            WHEN 'EQUIPMENT' THEN e.asset_id
            WHEN 'DOCUMENT' THEN coalesce(f.asset_id, f.linked_asset_id)
            WHEN 'AGENDA_ITEM' THEN (SELECT min(l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = t.target_id)
          END
      WHERE t.account_id = $1 AND t.resolved_at IS NULL
        AND NOT (t.target_type = 'DOCUMENT' AND (f.id IS NULL OR f.deleted_at IS NOT NULL))
        AND NOT (t.target_type = 'EQUIPMENT' AND (e.id IS NULL OR e.archived_at IS NOT NULL))
        AND NOT (t.target_type = 'AGENDA_ITEM' AND (ai.id IS NULL OR coalesce(trim(ai.manual_status), '') <> ''))
        AND NOT (t.target_type = 'ASSET' AND a.id IS NULL)
        AND (a.id IS NULL OR (${dispo}))
        AND ($2::int[] IS NULL
             OR (t.target_type = 'ASSET' AND t.target_id = ANY($2::int[]))
             OR (t.target_type = 'EQUIPMENT' AND e.asset_id = ANY($2::int[]))
             OR (t.target_type = 'DOCUMENT' AND ${DOC_OF_ASSETS('f', '$2')})
             OR (t.target_type = 'AGENDA_ITEM' AND EXISTS (SELECT 1 FROM agenda_asset_links x
                   WHERE x.agenda_item_id = t.target_id AND x.asset_id = ANY($2::int[]))))
      ORDER BY CASE t.priority WHEN 'DO_FIRST' THEN 0 WHEN 'DO_NEXT' THEN 1 ELSE 2 END, t.active_since ASC, t.id ASC
      LIMIT ${MAX_TODO_ROWS}`,
    [accountId, ids],
  );
  return r.map((x) => ({
    id: Number(x.id), title: String(x.title ?? ''),
    priority: (x.priority as TodoRow['priority']) ?? 'DO_NEXT',
    actionKind: (x.actionKind as TodoRow['actionKind']) ?? 'COMPLETE',
    ruleCode: String(x.ruleCode ?? ''), targetType: String(x.targetType), targetId: Number(x.targetId),
    fieldKey: (x.fieldKey as string | null) ?? null, dueDate: (x.dueDate as string | null) ?? null,
    activeSince: isoDate(x.activeSince),
    assetId: x.assetId == null ? null : Number(x.assetId), assetName: (x.assetName as string | null) ?? null,
    document: x.documentId == null ? null : { id: Number(x.documentId), title: String(x.documentTitle ?? 'Document') },
  }));
}

/** Échéances actives du compte dans une fenêtre (bornes incluses, `null` : ouverte). */
export async function listActiveDeadlines(
  accountId: number,
  opts: { assetIds?: number[]; from: string | null; to: string | null },
): Promise<DeadlineRow[]> {
  const col = await agendaFunctionalColumnsReady().catch(() => false);
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const r = await lignes(
    `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date, to_char(i.end_date, 'YYYY-MM-DD') AS "endDate",
            (i.occurrence_nature = 'FORECAST') AS forecast, i.home_category AS "homeCategory", i.origin_type AS "originType",
            i.origin_field_key AS "originFieldKey",
            ${col ? 'i.event_nature' : 'NULL::text'} AS "eventNature", ${col ? 'i.business_type' : 'NULL::text'} AS "businessType",
            EXISTS (SELECT 1 FROM agenda_asset_links x WHERE x.agenda_item_id = i.id) AS "hasLinks",
            coalesce((SELECT json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY a.id)
                        FROM agenda_asset_links l
                        JOIN assets a ON a.id = l.asset_id AND a.account_id = i.account_id AND ${assistantAssetAvailability.sql('a')}
                       WHERE l.agenda_item_id = i.id), '[]'::json) AS assets
       FROM agenda_items i
      WHERE i.account_id = $1 AND coalesce(trim(i.manual_status), '') = ''
        AND i.start_date IS NOT NULL
        AND ${NOT_HISTORICAL(col, '$5')}
        AND ($2::date IS NULL OR coalesce(greatest(i.end_date, i.start_date), i.start_date) >= $2::date)
        AND ($3::date IS NULL OR i.start_date <= $3::date)
        AND ($4::int[] IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links x WHERE x.agenda_item_id = i.id AND x.asset_id = ANY($4::int[])))
      ORDER BY i.start_date ASC, i.id ASC
      LIMIT ${MAX_DEADLINE_ROWS}`,
    [accountId, opts.from, opts.to, ids, [...HISTORICAL_FIELD_KEYS]],
  );
  const parsed = (v: unknown): Array<{ id: number; name: string }> => {
    const arr = (typeof v === 'string' ? JSON.parse(v) : v) as Array<{ id: number; name: string }> | null;
    return (arr ?? []).map((a) => ({ id: Number(a.id), name: String(a.name) }));
  };
  // Biens liés tous indisponibles (archivés, vendus, transmis, supprimés) :
  // l'échéance n'est plus une action du portefeuille actif.
  const actives = r.map((x) => ({ x, assets: parsed(x.assets) })).filter(({ x, assets }) => !x.hasLinks || assets.length > 0);
  const docs = await documentsOf(accountId, actives.map(({ x }) => Number(x.id)));
  return actives.map(({ x, assets }) => ({
    id: Number(x.id), title: String(x.title ?? ''), date: String(x.date), endDate: (x.endDate as string | null) ?? null,
    forecast: Boolean(x.forecast),
    isAction: isAgendaActionItemT4({
      homeCategory: (x.homeCategory as string | null) ?? null, originType: String(x.originType ?? 'manual'), title: String(x.title ?? ''),
      eventNature: (x.eventNature as string | null) ?? null, businessType: (x.businessType as string | null) ?? null,
      originFieldKey: (x.originFieldKey as string | null) ?? null,
    }),
    originFieldKey: (x.originFieldKey as string | null) ?? null,
    assets,
    documents: docs.get(Number(x.id)) ?? [],
  }));
}

/** Documents associés aux échéances (liens affichés, sources, document d'origine) — contexte. */
async function documentsOf(accountId: number, itemIds: number[]): Promise<Map<number, Array<{ id: number; title: string }>>> {
  const out = new Map<number, Array<{ id: number; title: string }>>();
  if (itemIds.length === 0) return out;
  const r = await lignes(
    `SELECT DISTINCT s.item AS "itemId", f.id, coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title
       FROM (
         SELECT agenda_item_id AS item, asset_file_id AS fid FROM agenda_file_links WHERE agenda_item_id = ANY($2::int[])
         UNION ALL
         SELECT agenda_item_id, asset_file_id FROM agenda_item_sources
          WHERE agenda_item_id = ANY($2::int[]) AND effect_type IN ('created', 'resolved_existing', 'linked')
         UNION ALL
         SELECT id, origin_ref_id FROM agenda_items
          WHERE id = ANY($2::int[]) AND account_id = $1 AND origin_ref_type = 'asset_file' AND origin_ref_id IS NOT NULL
       ) s
       JOIN asset_files f ON f.id = s.fid AND f.account_id = $1 AND f.deleted_at IS NULL
      ORDER BY 1, 2`,
    [accountId, itemIds],
  ).catch(() => [] as Row[]);
  for (const x of r) {
    const k = Number(x.itemId);
    const liste = out.get(k) ?? [];
    liste.push({ id: Number(x.id), title: String(x.title) });
    out.set(k, liste);
  }
  return out;
}

/** Lecture conjointe selon le contrat de la demande (sources réellement interrogées). */
export async function listActionables(accountId: number, opts: ActionableReadOptions): Promise<{
  todos: TodoRow[]; deadlines: DeadlineRow[]; queried: Array<'TODO' | 'DEADLINE'>;
}> {
  const [todos, deadlines] = await Promise.all([
    opts.todos ? listOpenTodos(accountId, { assetIds: opts.assetIds }) : Promise.resolve([] as TodoRow[]),
    opts.deadlines ? listActiveDeadlines(accountId, { assetIds: opts.assetIds, from: opts.from, to: opts.to }) : Promise.resolve([] as DeadlineRow[]),
  ]);
  const queried: Array<'TODO' | 'DEADLINE'> = [];
  if (opts.todos) queried.push('TODO');
  if (opts.deadlines) queried.push('DEADLINE');
  return { todos, deadlines, queried };
}
