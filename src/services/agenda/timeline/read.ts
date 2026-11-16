/**
 * Lot 84C — lecture de la Timeline d'un bien (CDC v5 §13, AC22–AC26, E10).
 * Serveur uniquement. Règles : `model.ts`.
 *
 * UNE fonction de lecture, utilisée par la vue d'ensemble du bien
 * (`/api/assets/[id]/overview`) ET par l'export de recette 82E
 * (`calculs/timeline.part-NNNN.ndjson.gz`) : même résultat partout.
 *
 * Requête (`TIMELINE_PAGE_SQL`) — #744 lot C, RÈGLE REMPLACÉE : la lecture ne
 * dépend plus du rôle « principal » ni de la colonne historique ; elle lit le
 * graphe canonique N↔N (`business_operation_agenda_links`). Détail : `model.ts`
 * et le commentaire de la requête.
 *   1. éléments du bien : `agenda_asset_links (asset_id)` → `agenda_items`
 *      (clé primaire), même compte ;
 *   2. liens actifs de ces éléments vers un événement de référence ACTIF du
 *      même compte ; événements de référence pertinents = ces liens ∪ ceux
 *      reliés au bien (y compris sans élément d'agenda) ;
 *   3. entrées = un événement de référence (mode regroupé), ou un élément sans
 *      événement de référence, ou tout élément (mode détaillé) — le
 *      regroupement est fait AVANT la pagination (E10, AC38) ;
 *   4. pagination par curseur sur (date décroissante, sans date en dernier,
 *      rang, identifiant) : identités typées, tri stable.
 * Puis, pour la seule page : éléments réels des groupes, compteurs, libellés
 * (une requête chacun, jamais une par entrée).
 *
 * Volume lu borné par la Timeline du bien (index `agenda_asset_links` par
 * bien) ; volume rendu borné par la page. Plan vérifié par l'e2e L84C-E08.
 */
import { documentTitleJsonSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import { presentationBasisOf } from '@/lib/reference-events/presentation-date';
import { presentationScalarSql } from '@/services/business-operations/graph/presentation-date';
import {
  DEFAULT_TIMELINE_MODE, decodeTimelineCursor, TIMELINE_PAGE_DEFAULT, TIMELINE_PAGE_MAX, compareTimelineItems, encodeTimelineCursor, timelineGroupEntryId, timelineItemView,
  type TimelineCursor, type TimelineEntry, type TimelineGroupCounters, type TimelineGroupDateBasis, type TimelineItemRow, type TimelineItemView,
  type TimelineMode, type TimelineOperationRef, type TimelinePage,
} from './model';

type Row = Record<string, unknown>;
/** Exécuteur SQL paramétré ($1…) : pool de l'application ou session d'export (instantané). */
export type TimelineQuery = (sql: string, params?: unknown[]) => Promise<Row[]>;

async function defaultQuery(): Promise<TimelineQuery> {
  const { pgClient } = await import('@/db');
  return async (sql, params = []) => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
}

/**
 * Heure / fin de l'élément (lot 111R). Lot 113P (#715) : plus de statut ni de
 * « preuve de réalisation » lus — un événement n'a plus de statut.
 */
const TIME_COLUMNS = `ai.start_time::text AS start_time, to_char(ai.end_date, 'YYYY-MM-DD') AS end_date, ai.end_time::text AS end_time`;

/** Événement de référence ACTIF (alias SQL `a`) du compte $1 : ni invalidé, ni fusionné. */
const opActif = (a: string): string => `${a}.account_id = $1 AND ${a}.invalidated_at IS NULL AND ${a}.merged_into_operation_id IS NULL`;
/**
 * Sous-requête SCALAIRE corrélée sur la clé primaire (jamais « hachée » sur
 * toute la table des événements de référence) : `col` de l'événement de
 * référence `id` s'il est actif dans le compte, sinon NULL.
 */
const opScalaire = (col: string, id: string): string =>
  `(SELECT ${col} FROM business_operations bo WHERE bo.id = ${id} AND ${opActif('bo')})`;

/**
 * $1 compte, $2 bien, $3 mode ('grouped' | 'detailed'), $4 date du curseur
 * (AAAA-MM-JJ | '-infinity' | NULL), $5 id du curseur, $6 limite (+1),
 * $7 rang du curseur (1 : événement de référence, 0 : élément d'agenda).
 *
 * #744 lot C (règle remplacée) : plus aucune lecture du rôle ni de la colonne
 * historique — les liens viennent du graphe `business_operation_agenda_links`.
 *   · `links`  : liens ACTIFS des éléments du bien vers un événement de
 *     référence actif du compte (index
 *     `business_operation_agenda_links_item_idx`, puis clé primaire) ;
 *   · `op_ids` : événements de référence pertinents pour le bien = ceux de
 *     `links` ∪ ceux reliés au bien (`business_operation_asset_links`, index
 *     par bien) — jamais un parcours de tous les événements de référence ;
 *   · `ops`    : repère de date = DATE DE PRÉSENTATION du CDC §11 (carte
 *     #744, point F — RÈGLE REMPLACÉE : plus de repli sur la date du plus
 *     ancien élément d'agenda lié). Règle unique :
 *     `@/lib/reference-events/presentation-date`, faits lus par
 *     `presentationScalarSql` (une sous-requête scalaire par événement de
 *     référence pertinent, sur la clé primaire) ; sans fait daté : aucune date ;
 *   · `entries`: mode regroupé = un rang 1 par événement de référence + les
 *     éléments sans lien actif ; mode détaillé = tous les éléments, une fois.
 */
export const TIMELINE_PAGE_SQL = `
WITH items AS MATERIALIZED (
  SELECT ai.id, ai.title, ai.start_date AS d, to_char(ai.start_date, 'YYYY-MM-DD') AS start_date,
         ai.origin_field_key, ai.event_nature, ai.business_type,
         ${TIME_COLUMNS}
    FROM agenda_asset_links aal
    JOIN agenda_items ai ON ai.id = aal.agenda_item_id
   WHERE aal.asset_id = $2 AND ai.account_id = $1
), links AS MATERIALIZED (
  SELECT l.agenda_item_id AS item_id, l.operation_id AS op
    FROM items i
    JOIN business_operation_agenda_links l ON l.account_id = $1 AND l.agenda_item_id = i.id AND l.state = 'ACTIVE'
   WHERE $3 = 'grouped' AND ${opScalaire('bo.id', 'l.operation_id')} IS NOT NULL
), op_ids AS (
  SELECT k.op FROM links k
  UNION
  SELECT b.operation_id FROM business_operation_asset_links b
   WHERE $3 = 'grouped' AND b.asset_id = $2 AND b.account_id = $1 AND b.active
     AND ${opScalaire('bo.id', 'b.operation_id')} IS NOT NULL
), op_pd AS MATERIALIZED (
  SELECT x.op, ${presentationScalarSql('x.op')} AS pd FROM op_ids x
), ops AS (
  SELECT y.op, split_part(y.pd, '|', 1)::date AS d, split_part(y.pd, '|', 2) AS basis FROM op_pd y
), entries AS (
  SELECT 0 AS rank, i.id::bigint AS id, i.title, i.start_date, i.origin_field_key, i.event_nature, i.business_type,
         i.start_time, i.end_date, i.end_time,
         COALESCE(i.d, '-infinity'::date) AS sort_date, NULL::text AS date_basis
    FROM items i
   WHERE $3 = 'detailed' OR i.id NOT IN (SELECT k.item_id FROM links k)
  UNION ALL
  SELECT 1 AS rank, o.op AS id, NULL::text AS title, to_char(o.d, 'YYYY-MM-DD') AS start_date,
         NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
         COALESCE(o.d, '-infinity'::date) AS sort_date, o.basis AS date_basis
    FROM ops o
)
SELECT e.rank, e.id, e.title, e.start_date, e.origin_field_key, e.event_nature, e.business_type,
       e.start_time, e.end_date, e.end_time,
       (e.rank = 1) AS is_group, e.date_basis,
       e.sort_date::text AS sort_key, count(*) OVER () AS remaining
  FROM entries e
 WHERE $4::date IS NULL OR (e.sort_date, e.rank, e.id) < ($4::date, $7::int, $5::bigint)
 ORDER BY e.sort_date DESC, e.rank DESC, e.id DESC
 LIMIT $6`;

/**
 * Éléments d'agenda RÉELS des événements de référence de la page, présents sur
 * la Timeline du bien ($1 compte, $2 bien, $3 événements de référence). Un
 * élément partagé rend une ligne par événement de référence (même identité).
 * Aucune limite : tous les membres du groupe sont chargés (AC38, AC39).
 */
export const TIMELINE_MEMBERS_SQL = `
SELECT ai.id, ai.title, to_char(ai.start_date, 'YYYY-MM-DD') AS start_date, ai.origin_field_key,
       ai.event_nature, ai.business_type, ${TIME_COLUMNS}, l.operation_id AS op
  FROM business_operation_agenda_links l
  JOIN agenda_items ai ON ai.id = l.agenda_item_id AND ai.account_id = $1
 WHERE l.account_id = $1 AND l.operation_id = ANY($3::bigint[]) AND l.state = 'ACTIVE'
   AND EXISTS (SELECT 1 FROM agenda_asset_links aal WHERE aal.agenda_item_id = ai.id AND aal.asset_id = $2)`;

/**
 * Compteurs distincts d'un groupe (§13.7) : appartenance ACTIVE à l'événement
 * de référence, objets du même compte seulement (une relation intercomptes
 * héritée n'est jamais lue — lot 53, D23). #744 lot C : plus de « principal »
 * — les éléments d'agenda comptés sont TOUS ses éléments réels (graphe), et
 * les liens directs d'un élément ne sont plus ajoutés à ceux de l'événement
 * de référence. $1 compte, $2 événements de référence.
 */
export const TIMELINE_COUNTERS_SQL = `
SELECT g.op,
  (SELECT count(*) FROM business_operation_agenda_links l
     JOIN agenda_items x ON x.id = l.agenda_item_id AND x.account_id = $1
    WHERE l.account_id = $1 AND l.operation_id = g.op AND l.state = 'ACTIVE')::int AS events,
  (SELECT count(*) FROM business_operation_documents d
     JOIN asset_files f ON f.id = d.file_id AND f.account_id = $1 AND f.deleted_at IS NULL
    WHERE d.operation_id = g.op AND d.account_id = $1 AND d.active)::int AS documents,
  (SELECT count(*) FROM business_operation_asset_links b
     JOIN assets a ON a.id = b.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
    WHERE b.operation_id = g.op AND b.account_id = $1 AND b.active)::int AS assets,
  (SELECT count(*) FROM business_operation_room_links r
     JOIN substructures s ON s.id = r.substructure_id JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
    WHERE r.operation_id = g.op AND r.account_id = $1 AND r.active)::int AS rooms,
  (SELECT count(*) FROM business_operation_equipment_links q
     JOIN equipments e ON e.id = q.equipment_id JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
    WHERE q.operation_id = g.op AND q.account_id = $1 AND q.active)::int AS equipments
  FROM unnest($2::bigint[]) AS g(op)`;

/**
 * Événements de référence ACTIFS des éléments d'agenda de la page (mode
 * détaillé) : $1 compte, $2 éléments. Lecture inverse du graphe N↔N.
 */
export const TIMELINE_ITEM_OPERATIONS_SQL = `
SELECT l.agenda_item_id AS item_id, l.operation_id AS op
  FROM business_operation_agenda_links l
 WHERE l.account_id = $1 AND l.agenda_item_id = ANY($2::int[]) AND l.state = 'ACTIVE'
   AND ${opScalaire('bo.id', 'l.operation_id')} IS NOT NULL
 ORDER BY l.agenda_item_id, l.operation_id`;

/**
 * De quoi NOMMER les événements de référence de la page ($1 compte, $2
 * événements de référence) : type, libellé, prestataire et titre du premier
 * justificatif — même repli que la fiche (`readReferenceEvent`), pour qu'un
 * événement de référence porte le MÊME nom sur la Timeline et dans sa fiche.
 */
export const TIMELINE_OPERATION_LABELS_SQL = `
SELECT bo.id AS op, bo.type_code, bo.technical_label, bo.provider,
       (SELECT ${documentTitleJsonSql('f')}
          FROM business_operation_documents d
          JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
         WHERE d.account_id = $1 AND d.operation_id = bo.id AND d.active
         ORDER BY f.document_date NULLS LAST, f.id LIMIT 1) AS first_document
  FROM business_operations bo
 WHERE bo.id = ANY($2::bigint[]) AND ${opActif('bo')}`;

interface ReadTimelineInput {
  accountId: number;
  assetId: number;
  mode?: TimelineMode;
  cursor?: TimelineCursor | null;
  limit?: number;
  /** Date de référence (AAAA-MM-JJ) — lot 113P : conservée pour la compatibilité, plus aucun état calculé. */
  today: string;
  /**
   * Lot 111R : instant de référence (la route passe l'instant de la requête,
   * comme l'Agenda). Absent : début de la journée `today` (export, tests).
   */
  now?: Date;
  q?: TimelineQuery;
}

const EMPTY_COUNTERS: TimelineGroupCounters = { events: 0, documents: 0, assets: 0, rooms: 0, equipments: 0 };

const texte = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Colonnes de titre du premier justificatif (jsonb déjà décodé, ou texte selon l'exécuteur SQL). */
function premierDocument(v: unknown): DocumentTitleColumns | null {
  if (v && typeof v === 'object') return v as DocumentTitleColumns;
  if (typeof v !== 'string') return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === 'object' ? (o as DocumentTitleColumns) : null;
  } catch {
    return null;
  }
}

/**
 * Libellés utilisateur des événements de référence (jamais « Opération ») :
 * règle existante `referenceEventLabel`, avec le titre du premier
 * justificatif en repli (comme la fiche). Une requête pour toute la page.
 */
async function operationLabels(q: TimelineQuery, accountId: number, ops: ReadonlySet<number>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ops.size) return out;
  const rows = await q(TIMELINE_OPERATION_LABELS_SQL, [accountId, [...ops]]);
  const { referenceEventLabel } = await import('@/services/documents/business-period-surfaces');
  for (const o of rows) {
    const premier = premierDocument(o.first_document);
    const doc = premier ? documentTitleOf(premier) : null;
    out.set(Number(o.op), referenceEventLabel({
      typeCode: texte(o.type_code), technicalLabel: texte(o.technical_label), provider: texte(o.provider), firstDocumentTitle: doc,
    }));
  }
  return out;
}

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
  const ref = input.now ?? input.today;
  const rows = await q(TIMELINE_PAGE_SQL, [
    input.accountId, input.assetId, mode, c?.sortDate ?? null, c?.id ?? null, limit + 1, c?.kind === 'group' ? 1 : 0,
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? encodeTimelineCursor(last.is_group === true
      ? { mode, sortDate: String(last.sort_key), id: Number(last.id), kind: 'group' }
      : { mode, sortDate: String(last.sort_key), id: Number(last.id) })
    : null;

  const groups = page.filter((r) => r.is_group === true);
  const items = page.filter((r) => r.is_group !== true);
  const members = new Map<number, TimelineItemView[]>();
  const counters = new Map<number, TimelineGroupCounters>();
  /** Événements de référence à nommer (têtes de groupe, ou liens des éléments en mode détaillé). */
  const aNommer = new Set<number>();
  const liensParElement = new Map<number, number[]>();

  if (groups.length) {
    const ops = groups.map((r) => Number(r.id));
    for (const op of ops) aNommer.add(op);
    const [mRows, cRows] = await Promise.all([
      q(TIMELINE_MEMBERS_SQL, [input.accountId, input.assetId, ops]),
      q(TIMELINE_COUNTERS_SQL, [input.accountId, ops]),
    ]);
    for (const r of mRows) {
      const op = Number(r.op);
      const list = members.get(op) ?? [];
      list.push(timelineItemView(r as unknown as TimelineItemRow, ref));
      members.set(op, list);
    }
    for (const r of cRows) {
      counters.set(Number(r.op), {
        events: Number(r.events), documents: Number(r.documents), assets: Number(r.assets), rooms: Number(r.rooms), equipments: Number(r.equipments),
      });
    }
  }
  if (mode === 'detailed' && items.length) {
    for (const r of await q(TIMELINE_ITEM_OPERATIONS_SQL, [input.accountId, items.map((x) => Number(x.id))])) {
      const item = Number(r.item_id);
      const op = Number(r.op);
      aNommer.add(op);
      const list = liensParElement.get(item) ?? [];
      if (!list.includes(op)) list.push(op);
      liensParElement.set(item, list);
    }
  }
  const labels = await operationLabels(q, input.accountId, aNommer);

  const entries: TimelineEntry[] = page.map((r): TimelineEntry => {
    if (r.is_group === true) {
      const op = Number(r.id);
      const basis: TimelineGroupDateBasis | null = presentationBasisOf(r.date_basis);
      return {
        kind: 'group', itemType: 'operation', id: timelineGroupEntryId(op), operationId: op,
        title: labels.get(op) ?? '',
        effectiveDate: basis === null ? null : texte(r.start_date),
        dateBasis: basis,
        members: (members.get(op) ?? []).sort(compareTimelineItems),
        counters: counters.get(op) ?? { ...EMPTY_COUNTERS },
      };
    }
    const view = timelineItemView(r as unknown as TimelineItemRow, ref);
    if (mode !== 'detailed') return { kind: 'item', ...view };
    const operations: TimelineOperationRef[] = (liensParElement.get(Number(r.id)) ?? []).map((op) => ({ operationId: op, label: labels.get(op) ?? '' }));
    return { kind: 'item', ...view, operations };
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
