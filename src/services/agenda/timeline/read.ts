/**
 * Lot 84C — lecture de la Timeline d'un bien (CDC v5 §13, AC22–AC26, E10).
 * Serveur uniquement. Règles : `model.ts`.
 *
 * UNE fonction de lecture, utilisée par la vue d'ensemble du bien
 * (`/api/assets/[id]/overview`) ET par l'export de recette 82E
 * (`calculs/timeline.part-NNNN.ndjson.gz`) : même résultat partout.
 *
 * Requête (`TIMELINE_PAGE_SQL`) :
 *   1. éléments du bien : `agenda_asset_links (asset_id)` → `agenda_items`
 *      (clé primaire), même compte, « annule » exclu ; l'Opération n'est
 *      retenue que si elle est ACTIVE et du même compte (sinon élément seul),
 *      vérifié par sa clé primaire pour les seuls éléments rattachés (jamais
 *      un parcours de toutes les Opérations) ;
 *   2. FENÊTRE PAR OPÉRATION : tête de groupe = principal daté présent sur la
 *      Timeline du bien (`max(id) FILTER (…) OVER (PARTITION BY op)`) ;
 *   3. entrées = tête de groupe, ou élément hors groupe (mode regroupé), ou
 *      tout élément (mode détaillé) — le regroupement est fait AVANT la
 *      pagination (E10) ;
 *   4. pagination par curseur sur (date décroissante, sans date en dernier,
 *      identifiant) : `(sort_date, id) < (curseur)` + LIMIT n + 1.
 * Puis, pour les seules têtes de la page : éléments liés masqués (index
 * `agenda_items_business_operation_idx` + unicité du lien au bien) et
 * compteurs (index des liens d'Opération, tous menés par `operation_id`).
 *
 * Volume lu borné par la Timeline du bien (index `agenda_asset_links` par
 * bien) ; volume rendu borné par la page. Plan vérifié par l'e2e L84C-E08.
 */
import {
  DEFAULT_TIMELINE_MODE, decodeTimelineCursor, TIMELINE_PAGE_DEFAULT, TIMELINE_PAGE_MAX, compareTimelineItems, encodeTimelineCursor, timelineItemView,
  type TimelineCursor, type TimelineEntry, type TimelineGroupCounters, type TimelineItemRow, type TimelineItemView, type TimelineMode, type TimelinePage,
} from './model';

type Row = Record<string, unknown>;
/** Exécuteur SQL paramétré ($1…) : pool de l'application ou session d'export (instantané). */
export type TimelineQuery = (sql: string, params?: unknown[]) => Promise<Row[]>;

async function defaultQuery(): Promise<TimelineQuery> {
  const { pgClient } = await import('@/db');
  return async (sql, params = []) => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
}

const NOT_CANCELLED = `(ai.manual_status IS NULL OR ai.manual_status <> 'annule')`;

/**
 * $1 compte, $2 bien, $3 mode ('grouped' | 'detailed'), $4 date du curseur
 * (AAAA-MM-JJ | '-infinity' | NULL), $5 id du curseur, $6 limite (+1).
 */
export const TIMELINE_PAGE_SQL = `
WITH items AS MATERIALIZED (
  SELECT ai.id, ai.title, ai.start_date AS d, to_char(ai.start_date, 'YYYY-MM-DD') AS start_date,
         ai.manual_status, ai.origin_field_key, ai.event_nature, ai.business_type,
         -- Sous-requête SCALAIRE corrélée (jamais « hachée » sur toute la table) :
         -- une lecture par clé primaire, pour les seuls éléments rattachés.
         CASE WHEN ai.business_operation_id IS NOT NULL THEN (
                SELECT bo.id FROM business_operations bo
                 WHERE bo.id = ai.business_operation_id AND bo.account_id = ai.account_id AND bo.invalidated_at IS NULL)
              END AS op,
         ai.operation_role AS role
    FROM agenda_asset_links aal
    JOIN agenda_items ai ON ai.id = aal.agenda_item_id
   WHERE aal.asset_id = $2 AND ai.account_id = $1 AND ${NOT_CANCELLED}
), heads AS (
  SELECT i.*,
         CASE WHEN i.op IS NULL THEN NULL
              ELSE max(i.id) FILTER (WHERE i.role = 'PRINCIPAL' AND i.d IS NOT NULL) OVER (PARTITION BY i.op) END AS head
    FROM items i
), entries AS (
  SELECT h.*, COALESCE(h.d, '-infinity'::date) AS sort_date, ($3 = 'grouped' AND h.head = h.id) AS is_head
    FROM heads h
   WHERE $3 = 'detailed' OR h.head IS NULL OR h.head = h.id
)
SELECT e.id, e.title, e.start_date, e.manual_status, e.origin_field_key, e.event_nature, e.business_type,
       e.op, e.is_head, e.sort_date::text AS sort_key, count(*) OVER () AS remaining
  FROM entries e
 WHERE $4::date IS NULL OR (e.sort_date, e.id) < ($4::date, $5::int)
 ORDER BY e.sort_date DESC, e.id DESC
 LIMIT $6`;

/** Éléments liés masqués des têtes de la page ($3 : Opérations, $4 : têtes). */
export const TIMELINE_MEMBERS_SQL = `
SELECT ai.id, ai.title, to_char(ai.start_date, 'YYYY-MM-DD') AS start_date, ai.manual_status, ai.origin_field_key,
       ai.event_nature, ai.business_type, ai.business_operation_id AS op
  FROM agenda_items ai
 WHERE ai.business_operation_id = ANY($3::bigint[]) AND ai.account_id = $1 AND ${NOT_CANCELLED}
   AND ai.id <> ALL($4::int[])
   AND EXISTS (SELECT 1 FROM agenda_asset_links aal WHERE aal.agenda_item_id = ai.id AND aal.asset_id = $2)`;

/**
 * Compteurs distincts d'un groupe (§13.7) : appartenance de l'Opération
 * (actifs) ∪ liens directs du principal, objets du même compte seulement
 * (une relation intercomptes héritée n'est jamais lue — lot 53, D23).
 * $1 compte, $2 Opérations, $3 têtes (même ordre).
 */
export const TIMELINE_COUNTERS_SQL = `
SELECT g.op,
  (SELECT count(*) FROM agenda_items x
    WHERE x.business_operation_id = g.op AND x.account_id = $1 AND x.id <> g.head
      AND (x.manual_status IS NULL OR x.manual_status <> 'annule'))::int AS events,
  (SELECT count(*) FROM (
      SELECT d.file_id AS id FROM business_operation_documents d WHERE d.operation_id = g.op AND d.account_id = $1 AND d.active
      UNION SELECT l.asset_file_id FROM agenda_file_links l WHERE l.agenda_item_id = g.head) u
    JOIN asset_files f ON f.id = u.id AND f.account_id = $1 AND f.deleted_at IS NULL)::int AS documents,
  (SELECT count(*) FROM (
      SELECT b.asset_id AS id FROM business_operation_asset_links b WHERE b.operation_id = g.op AND b.account_id = $1 AND b.active
      UNION SELECT l.asset_id FROM agenda_asset_links l WHERE l.agenda_item_id = g.head) u
    JOIN assets a ON a.id = u.id AND a.account_id = $1 AND a.deleted_at IS NULL)::int AS assets,
  (SELECT count(*) FROM (
      SELECT r.substructure_id AS id FROM business_operation_room_links r WHERE r.operation_id = g.op AND r.account_id = $1 AND r.active
      UNION SELECT l.substructure_id FROM agenda_room_links l WHERE l.agenda_item_id = g.head) u
    JOIN substructures s ON s.id = u.id JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL)::int AS rooms,
  (SELECT count(*) FROM (
      SELECT q.equipment_id AS id FROM business_operation_equipment_links q WHERE q.operation_id = g.op AND q.account_id = $1 AND q.active
      UNION SELECT l.equipment_id FROM agenda_equipment_links l WHERE l.agenda_item_id = g.head) u
    JOIN equipments e ON e.id = u.id JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL)::int AS equipments
  FROM unnest($2::bigint[], $3::int[]) AS g(op, head)`;

interface ReadTimelineInput {
  accountId: number;
  assetId: number;
  mode?: TimelineMode;
  cursor?: TimelineCursor | null;
  limit?: number;
  /** Date de référence (AAAA-MM-JJ) des états « en retard » / « à confirmer ». */
  today: string;
  q?: TimelineQuery;
}

const EMPTY_COUNTERS: TimelineGroupCounters = { events: 0, documents: 0, assets: 0, rooms: 0, equipments: 0 };

/**
 * Une page de la Timeline du bien. L'appelant a vérifié que le bien
 * appartient au compte ; la requête ne lit de toute façon que des éléments
 * du compte.
 */
export async function readAssetTimelinePage(input: ReadTimelineInput): Promise<TimelinePage> {
  const q = input.q ?? await defaultQuery();
  const mode = input.mode ?? DEFAULT_TIMELINE_MODE;
  const limit = Math.max(1, Math.min(input.limit ?? TIMELINE_PAGE_DEFAULT, TIMELINE_PAGE_MAX));
  const c = input.cursor && input.cursor.mode === mode ? input.cursor : null;
  const rows = await q(TIMELINE_PAGE_SQL, [input.accountId, input.assetId, mode, c?.sortDate ?? null, c?.id ?? null, limit + 1]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? encodeTimelineCursor({ mode, sortDate: String(last.sort_key), id: Number(last.id) })
    : null;

  const heads = page.filter((r) => r.is_head === true);
  const members = new Map<number, TimelineItemView[]>();
  const counters = new Map<number, TimelineGroupCounters>();
  if (heads.length) {
    const ops = heads.map((r) => Number(r.op));
    const headIds = heads.map((r) => Number(r.id));
    const [mRows, cRows] = await Promise.all([
      q(TIMELINE_MEMBERS_SQL, [input.accountId, input.assetId, ops, headIds]),
      q(TIMELINE_COUNTERS_SQL, [input.accountId, ops, headIds]),
    ]);
    for (const r of mRows) {
      const op = Number(r.op);
      const list = members.get(op) ?? [];
      list.push(timelineItemView(r as unknown as TimelineItemRow, input.today));
      members.set(op, list);
    }
    for (const r of cRows) {
      counters.set(Number(r.op), {
        events: Number(r.events), documents: Number(r.documents), assets: Number(r.assets), rooms: Number(r.rooms), equipments: Number(r.equipments),
      });
    }
  }

  const entries: TimelineEntry[] = page.map((r) => {
    const view = timelineItemView(r as unknown as TimelineItemRow, input.today);
    if (r.is_head !== true) return { kind: 'item', ...view };
    const op = Number(r.op);
    const ms = (members.get(op) ?? []).sort(compareTimelineItems);
    return { kind: 'group', ...view, members: ms, counters: counters.get(op) ?? { ...EMPTY_COUNTERS } };
  });
  return { mode, entries, nextCursor, remaining: Number(rows[0]?.remaining ?? 0) };
}

/**
 * Toute la Timeline du bien dans un mode (pages successives, même fonction) :
 * export de recette. `pageSize` borne chaque requête rendue.
 */
export async function readAssetTimelineAll(input: Omit<ReadTimelineInput, 'cursor' | 'limit'> & { pageSize?: number }): Promise<TimelineEntry[]> {
  const out: TimelineEntry[] = [];
  let cursor: TimelineCursor | null = null;
  const mode = input.mode ?? DEFAULT_TIMELINE_MODE;
  for (;;) {
    const p = await readAssetTimelinePage({ ...input, mode, cursor, limit: input.pageSize ?? TIMELINE_PAGE_MAX });
    out.push(...p.entries);
    if (!p.nextCursor) return out;
    const next = decodeTimelineCursor(p.nextCursor, mode);
    if (!next || next === 'INVALID') return out;
    cursor = next;
  }
}
