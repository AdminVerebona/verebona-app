/**
 * BO › fiche compte › « Données du compte » — LISTES par catégorie (lot 75N).
 *
 * Pagination, tri et filtres côté serveur (listes blanches), requêtes
 * bornées au compte, compteurs réels par état. Chaque appel s'exécute dans
 * une transaction `READ ONLY` (`readOnlyExecutor` du diagnostic des
 * Opérations) : PostgreSQL refuse toute écriture (25006).
 *
 * Opérations : liste du `OperationDiagnosticsService` (réutilisée telle
 * quelle, filtre compte + recherche), aucune requête parallèle.
 */
import { containsPattern } from '@/services/admin/list-params';
import { OperationDiagnosticsService, readOnlyExecutor, type DiagExecutor, type DiagQuery } from '@/services/business-operations/diagnostics/service';
import type { OperationState } from '@/services/business-operations/diagnostics/model';
import { ASSET_STATUS_LABELS } from '@/lib/asset-status';
import { type Category, type EntityType } from './model';

const LIST_PAGE_SIZE = 25;
const LIST_MAX_PAGE_SIZE = 100;

export interface ListQuery {
  q: string;
  sort: string;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  /** Filtre d'état propre à la catégorie (liste blanche `LIST_FILTERS`). */
  state: string;
}

export interface ListItem {
  type: EntityType;
  id: number;
  name: string;
  kind: string | null;
  status: string | null;
  statusLabel: string | null;
  /** État logique : actif, archivé, supprimé, invalidée, fusionnée, historique. */
  state: string;
  parent: { type: EntityType; id: number; label: string } | null;
  dates: Array<{ label: string; value: string | null }>;
}

export interface ListResult {
  category: Category;
  items: ListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: string;
  dir: 'asc' | 'desc';
  state: string;
  /** Compteurs réels par valeur du filtre d'état (sans recherche). */
  counters: Array<{ value: string; label: string; count: number }>;
}

/** Filtres d'état (première valeur = défaut) et tris admis par catégorie. */
export const LIST_FILTERS: Readonly<Record<Category, ReadonlyArray<{ value: string; label: string }>>> = {
  biens: [{ value: 'all', label: 'Tous' }, { value: 'active', label: 'En portefeuille' }, { value: 'archived', label: 'Archivés / sortis' }, { value: 'deleted', label: 'Supprimés' }],
  equipements: [{ value: 'all', label: 'Tous' }, { value: 'active', label: 'Actifs' }, { value: 'archived', label: 'Archivés' }, { value: 'deleted', label: 'Bien supprimé' }],
  pieces: [{ value: 'all', label: 'Toutes' }, { value: 'active', label: 'Actives' }, { value: 'deleted', label: 'Bien supprimé' }],
  documents: [{ value: 'all', label: 'Tous' }, { value: 'active', label: 'Actifs' }, { value: 'archived', label: 'Regroupés / ignorés' }, { value: 'deleted', label: 'Supprimés' }],
  echeances: [{ value: 'agenda', label: 'Agenda (actif)' }, { value: 'deadlines', label: 'Historique deadlines' }],
  operations: [{ value: 'all', label: 'Toutes' }, { value: 'active', label: 'Actives' }, { value: 'invalidated', label: 'Invalidées' }, { value: 'merged', label: 'Fusionnées' }],
};

export const LIST_SORTS: Readonly<Record<Category, readonly string[]>> = {
  biens: ['created', 'id', 'name', 'updated'],
  equipements: ['created', 'id', 'name', 'updated'],
  pieces: ['created', 'id', 'name', 'updated'],
  documents: ['uploaded', 'id', 'name', 'date', 'updated'],
  echeances: ['date', 'id', 'name', 'created'],
  operations: ['created'],
};

type Params = { get(name: string): string | null };

/** Paramètres d'URL → requête bornée (toute valeur hors liste blanche retombe sur le défaut). */
export function parseListQuery(category: Category, p: Params): ListQuery {
  const sorts = LIST_SORTS[category];
  const sort = sorts.includes(p.get('sort') ?? '') ? String(p.get('sort')) : sorts[0];
  const dir = p.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(p.get('page')) || 1)));
  const pageSize = Math.min(LIST_MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(p.get('pageSize')) || LIST_PAGE_SIZE)));
  const states = LIST_FILTERS[category].map((f) => f.value);
  const state = states.includes(p.get('state') ?? '') ? String(p.get('state')) : states[0];
  const q = (p.get('q') ?? '').trim().slice(0, 200);
  return { q, sort, dir, page, pageSize, state };
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const ts = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const int = (v: unknown) => Number(v ?? 0);
const isId = (q: string) => /^\d{1,9}$/.test(q);

interface CategorySql {
  /** FROM … (alias principal `x`) et condition d'appartenance au compte ($1). */
  from: string;
  /** Expression SQL de l'état logique (texte). */
  stateExpr: string;
  /** Condition de recherche (`$2` = motif ILIKE, `$3` = identifiant ou NULL). */
  search: string;
  order: Record<string, string>;
  columns: string;
  map: (r: Row) => ListItem;
}

const ASSET_STATE = `CASE WHEN x.deleted_at IS NOT NULL THEN 'deleted' WHEN x.status IN ('VENDU', 'TRANSMIS', 'ARCHIVED') THEN 'archived' ELSE 'active' END`;

const SQL: Readonly<Record<Exclude<Category, 'operations' | 'echeances'> | 'agenda' | 'deadlines', CategorySql>> = {
  biens: {
    from: `FROM assets x WHERE x.account_id = $1`,
    stateExpr: ASSET_STATE,
    search: `(x.name ILIKE $2 OR x.registration_number ILIKE $2 OR x.category ILIKE $2 OR x.id = $3::int)`,
    order: { created: 'x.created_at', id: 'x.id', name: 'lower(x.name)', updated: 'x.updated_at' },
    columns: `x.id, x.name, x.category, x.subtype, x.status, x.created_at, x.updated_at, x.deleted_at, x.purchase_date::text AS purchase_date`,
    map: (r) => ({
      type: 'asset', id: int(r.id), name: str(r.name) ?? `Bien #${r.id}`, kind: [str(r.category), str(r.subtype)].filter(Boolean).join(' · ') || null,
      status: str(r.status), statusLabel: ASSET_STATUS_LABELS[String(r.status) as keyof typeof ASSET_STATUS_LABELS] ?? str(r.status),
      state: String(r.etat), parent: null,
      dates: [{ label: 'Créé', value: ts(r.created_at) }, { label: 'Modifié', value: ts(r.updated_at) }, { label: 'Achat', value: str(r.purchase_date) }, ...(r.deleted_at ? [{ label: 'Supprimé', value: ts(r.deleted_at) }] : [])],
    }),
  },
  equipements: {
    from: `FROM equipments x JOIN assets a ON a.id = x.asset_id AND a.account_id = $1 LEFT JOIN substructures s ON s.id = x.substructure_id WHERE true`,
    stateExpr: `CASE WHEN a.deleted_at IS NOT NULL THEN 'deleted' WHEN x.archived_at IS NOT NULL THEN 'archived' ELSE 'active' END`,
    search: `(x.name ILIKE $2 OR x.type ILIKE $2 OR x.category ILIKE $2 OR x.id = $3::int
              OR EXISTS (SELECT 1 FROM equipment_cil_specs c WHERE c.equipment_id = x.id AND (c.brand ILIKE $2 OR c.model ILIKE $2 OR c.serial_number ILIKE $2)))`,
    order: { created: 'x.created_at', id: 'x.id', name: 'lower(x.name)', updated: 'x.updated_at' },
    columns: `x.id, x.name, x.type, x.category, x.status, x.created_at, x.updated_at, x.archived_at, a.id AS asset_id, a.name AS asset_name, s.id AS room_id, s.name AS room_name`,
    map: (r) => ({
      type: 'equipment', id: int(r.id), name: str(r.name) ?? `Équipement #${r.id}`, kind: [str(r.type), str(r.category)].filter(Boolean).join(' · ') || null,
      status: str(r.status), statusLabel: str(r.status), state: String(r.etat),
      parent: { type: 'asset', id: int(r.asset_id), label: `${str(r.asset_name) ?? 'Bien'}${r.room_id ? ` › ${str(r.room_name) ?? `pièce #${r.room_id}`}` : ''}` },
      dates: [{ label: 'Créé', value: ts(r.created_at) }, { label: 'Modifié', value: ts(r.updated_at) }, ...(r.archived_at ? [{ label: 'Archivé', value: ts(r.archived_at) }] : [])],
    }),
  },
  pieces: {
    from: `FROM substructures x JOIN assets a ON a.id = x.asset_id AND a.account_id = $1 WHERE true`,
    stateExpr: `CASE WHEN a.deleted_at IS NOT NULL THEN 'deleted' ELSE 'active' END`,
    search: `(x.name ILIKE $2 OR x.room_type ILIKE $2 OR x.id = $3::int)`,
    order: { created: 'x.created_at', id: 'x.id', name: 'lower(x.name)', updated: 'x.updated_at' },
    columns: `x.id, x.name, x.room_type, x.area, x.created_at, x.updated_at, a.id AS asset_id, a.name AS asset_name,
              (SELECT count(*) FROM equipments e WHERE e.substructure_id = x.id)::int AS equipments`,
    map: (r) => ({
      type: 'room', id: int(r.id), name: str(r.name) ?? `Pièce #${r.id}`, kind: [str(r.room_type), r.area ? `${r.area} m²` : null, `${int(r.equipments)} équipement(s)`].filter(Boolean).join(' · '),
      status: null, statusLabel: null, state: String(r.etat),
      parent: { type: 'asset', id: int(r.asset_id), label: str(r.asset_name) ?? 'Bien' },
      dates: [{ label: 'Créée', value: ts(r.created_at) }, { label: 'Modifiée', value: ts(r.updated_at) }],
    }),
  },
  documents: {
    from: `FROM asset_files x LEFT JOIN assets a ON a.id = coalesce(x.asset_id, x.linked_asset_id) AND a.account_id = x.account_id WHERE x.account_id = $1`,
    stateExpr: `CASE WHEN x.deleted_at IS NOT NULL THEN 'deleted' WHEN x.grouped_into_file_id IS NOT NULL OR x.is_ignored THEN 'archived' ELSE 'active' END`,
    // Recherche sur le titre retenu, le type, le fournisseur — jamais sur le nom du fichier original.
    search: `(x.retained_title ILIKE $2 OR x.document_type_code ILIKE $2 OR x.document_type ILIKE $2 OR x.supplier ILIKE $2 OR x.id = $3::int)`,
    order: { uploaded: 'coalesce(x.uploaded_at, x.created_at)', id: 'x.id', name: 'lower(coalesce(x.retained_title, x.document_type_code, x.document_type))', date: 'x.document_date', updated: 'x.updated_at' },
    columns: `x.id, x.retained_title, coalesce(x.document_type_code, x.document_type) AS doc_type, x.is_web_link, x.file_extension, x.analysis_state,
              x.document_date::text AS document_date, coalesce(x.uploaded_at, x.created_at) AS uploaded_at, x.deleted_at, x.amount_cents,
              a.id AS asset_id, a.name AS asset_name`,
    map: (r) => ({
      type: 'document', id: int(r.id),
      name: str(r.retained_title) ?? `${str(r.doc_type) ?? 'Document non classé'}${r.document_date ? ` du ${String(r.document_date).split('-').reverse().join('/')}` : ''}`,
      kind: [str(r.doc_type) ?? 'Non classé', r.is_web_link ? 'lien web' : str(r.file_extension)].filter(Boolean).join(' · '),
      status: str(r.analysis_state), statusLabel: str(r.analysis_state), state: String(r.etat),
      parent: r.asset_id ? { type: 'asset', id: int(r.asset_id), label: str(r.asset_name) ?? 'Bien' } : null,
      dates: [{ label: 'Document', value: str(r.document_date) }, { label: 'Dépôt', value: ts(r.uploaded_at) }, ...(r.deleted_at ? [{ label: 'Supprimé', value: ts(r.deleted_at) }] : [])],
    }),
  },
  agenda: {
    from: `FROM agenda_items x WHERE x.account_id = $1`,
    stateExpr: `'active'`,
    search: `(x.title ILIKE $2 OR x.business_type ILIKE $2 OR x.origin_field_key ILIKE $2 OR x.id = $3::int)`,
    order: { date: 'x.start_date', id: 'x.id', name: 'lower(x.title)', created: 'x.created_at' },
    columns: `x.id, x.title, x.start_date::text AS start_date, x.end_date::text AS end_date, x.manual_status, x.event_nature, x.business_type, x.origin_type,
              x.is_automatic, x.confirmed_at, x.created_at,
              (SELECT a.id FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = x.account_id WHERE l.agenda_item_id = x.id ORDER BY l.id LIMIT 1) AS asset_id,
              (SELECT a.name FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = x.account_id WHERE l.agenda_item_id = x.id ORDER BY l.id LIMIT 1) AS asset_name`,
    map: (r) => ({
      type: 'agenda', id: int(r.id), name: str(r.title) ?? `Échéance #${r.id}`,
      kind: [str(r.event_nature), str(r.business_type), str(r.origin_type), r.is_automatic ? 'automatique' : 'manuelle'].filter(Boolean).join(' · '),
      status: str(r.manual_status), statusLabel: r.confirmed_at ? `${str(r.manual_status) ?? '—'} · confirmée` : str(r.manual_status), state: 'active',
      parent: r.asset_id ? { type: 'asset', id: int(r.asset_id), label: str(r.asset_name) ?? 'Bien' } : null,
      dates: [{ label: 'Date', value: str(r.start_date) }, ...(r.end_date ? [{ label: 'Fin', value: str(r.end_date) }] : []), { label: 'Créée', value: ts(r.created_at) }],
    }),
  },
  deadlines: {
    from: `FROM deadlines x LEFT JOIN assets a ON a.id = coalesce(x.asset_id, x.linked_asset_id) AND a.account_id = x.account_id WHERE x.account_id = $1`,
    stateExpr: `'historique'`,
    search: `(x.label ILIKE $2 OR x.deadline_type ILIKE $2 OR x.id = $3::int)`,
    order: { date: 'x.deadline_date', id: 'x.id', name: 'lower(x.label)', created: 'x.created_at' },
    columns: `x.id, x.label, x.deadline_date::text AS deadline_date, x.deadline_type, x.is_done, x.created_at, a.id AS asset_id, a.name AS asset_name`,
    map: (r) => ({
      type: 'deadline', id: int(r.id), name: str(r.label) ?? `Échéance historique #${r.id}`, kind: [str(r.deadline_type), 'table deadlines (historique)'].filter(Boolean).join(' · '),
      status: r.is_done ? 'DONE' : 'OPEN', statusLabel: r.is_done ? 'Faite' : 'Ouverte', state: 'historique',
      parent: r.asset_id ? { type: 'asset', id: int(r.asset_id), label: str(r.asset_name) ?? 'Bien' } : null,
      dates: [{ label: 'Date', value: str(r.deadline_date) }, { label: 'Créée', value: ts(r.created_at) }],
    }),
  },
};

async function listSql(q: DiagQuery, key: keyof typeof SQL, accountId: number, lq: ListQuery, counterValues: ReadonlyArray<{ value: string; label: string }>) {
  const c = SQL[key];
  // Paramètres numérotés à la demande : un paramètre transmis mais absent de
  // la requête serait de type indéterminé pour PostgreSQL.
  const params: unknown[] = [accountId];
  let searchCond = '';
  if (lq.q) {
    params.push(containsPattern(lq.q), isId(lq.q) ? Number(lq.q) : null);
    searchCond = `AND ${c.search}`;
  } else {
    params.push(null, null);
    searchCond = 'AND $2::text IS NULL AND $3::int IS NULL';
  }
  const filtered = lq.state !== 'all' && lq.state !== 'agenda' && lq.state !== 'deadlines';
  params.push(filtered ? lq.state : null);
  const stateCond = filtered ? `AND (${c.stateExpr}) = $4::text` : 'AND $4::text IS NULL';
  const [{ n }] = await q(`SELECT count(*)::int AS n ${c.from} ${searchCond} ${stateCond}`, params);
  const total = int(n);
  const totalPages = Math.max(1, Math.ceil(total / lq.pageSize));
  const page = Math.min(lq.page, totalPages);
  const d = lq.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = await q(
    `SELECT ${c.columns}, (${c.stateExpr}) AS etat ${c.from} ${searchCond} ${stateCond}
      ORDER BY ${c.order[lq.sort] ?? Object.values(c.order)[0]} ${d} NULLS LAST, x.id ${d}
      LIMIT ${lq.pageSize} OFFSET ${(page - 1) * lq.pageSize}`,
    params,
  );
  const counts = await q(`SELECT (${c.stateExpr}) AS etat, count(*)::int AS n ${c.from} GROUP BY 1`, [accountId]);
  const by = new Map(counts.map((r) => [String(r.etat), int(r.n)]));
  const all = [...by.values()].reduce((a, b) => a + b, 0);
  return {
    items: rows.map(c.map), page, total, totalPages,
    counters: counterValues.map((f) => ({ value: f.value, label: f.label, count: f.value === 'all' ? all : by.get(f.value) ?? 0 })),
  };
}

/** Liste paginée d'une catégorie du compte (lecture seule). */
export async function listAccountData(
  accountId: number, category: Category, lq: ListQuery, exec: DiagExecutor = readOnlyExecutor,
): Promise<ListResult> {
  const base = { category, pageSize: lq.pageSize, sort: lq.sort, dir: lq.dir, state: lq.state };
  if (category === 'operations') {
    const svc = new OperationDiagnosticsService(exec);
    const filters = { accountId, type: null, status: null, withoutAsset: false, withoutSource: false, from: null, to: null, page: lq.page, pageSize: lq.pageSize };
    const res = await svc.list({ ...filters, state: lq.state as OperationState, q: lq.q || null, dir: lq.dir });
    const counters = await Promise.all(LIST_FILTERS.operations.map(async (f) => ({
      value: f.value, label: f.label, count: (await svc.list({ ...filters, state: f.value as OperationState, page: 1, pageSize: 1 })).total,
    })));
    return {
      ...base, total: res.total, page: res.page, totalPages: res.totalPages, counters,
      items: res.items.map((o) => ({
        type: 'operation', id: o.id, name: o.label ?? o.typeLabel, kind: o.typeLabel, status: o.status, statusLabel: o.status,
        state: o.mergedIntoOperationId ? 'merged' : o.invalidatedAt ? 'invalidated' : 'active',
        parent: o.assets[0] ? { type: 'asset', id: o.assets[0].id, label: o.assets[0].name ?? 'Bien' } : null,
        dates: [{ label: 'Date principale', value: o.principalDate }, { label: 'Créée', value: o.createdAt }],
      })),
    };
  }
  const key = category === 'echeances' ? (lq.state === 'deadlines' ? 'deadlines' : 'agenda') : category;
  return exec(async (q) => {
    if (category === 'echeances') {
      // Deux tables distinctes (agenda actif / historique `deadlines`) : jamais mélangées dans une même page.
      const r = await listSql(q, key, accountId, lq, []);
      const [agenda] = await q(`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = $1`, [accountId]);
      const [hist] = await q(`SELECT count(*)::int AS n FROM deadlines WHERE account_id = $1`, [accountId]);
      return { ...base, ...r, counters: [
        { value: 'agenda', label: LIST_FILTERS.echeances[0].label, count: int(agenda?.n) },
        { value: 'deadlines', label: LIST_FILTERS.echeances[1].label, count: int(hist?.n) },
      ] };
    }
    const r = await listSql(q, key, accountId, lq, LIST_FILTERS[category]);
    return { ...base, ...r };
  });
}

