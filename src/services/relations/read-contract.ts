/**
 * Lot 109A — CONTRAT SERVEUR UNIQUE DE LECTURE DES RELATIONS MÉTIER (ticket
 * P1 « Relations métier », §6). Lecture seule, bornée au compte dans CHAQUE
 * requête ; utilisé par les API des fiches (équipement, fournisseur,
 * document, Agenda), leurs compteurs et le rapport BO.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX NIVEAUX, JAMAIS CONFONDUS (§2)
 *
 *   DIRECT         preuve propre au document (ou décision de l'utilisateur) :
 *                  document_suppliers, document_asset_links / colonne
 *                  historique asset_files.equipment_id, agenda_file_links
 *                  MANUAL_DIRECT / AI_DIRECT, agenda_item_suppliers,
 *                  agenda_equipment_links, equipment_suppliers ;
 *   VIA_OPERATION  l'objet appartient à une Opération ACTIVE associée à
 *                  l'entité (business_operation_documents actif ×
 *                  business_operation_suppliers actif /
 *                  business_operation_equipment_links actif /
 *                  agenda_items.business_operation_id).
 * Le second rend l'objet CONSULTABLE au travers de l'Opération ; il n'est
 * jamais matérialisé en lien direct (aucun produit cartésien : une Opération
 * de 10 documents × 3 équipements × 2 fournisseurs n'écrit AUCUN lien — la
 * relation est calculée à la lecture).
 *
 * CHAQUE OBJET UNE FOIS (§6 « Compteurs / listes ») : agrégation par
 * identifiant (document, élément, équipement, fournisseur) ; l'objet porte
 * TOUTES ses preuves directes et TOUTES ses Opérations de contexte ; sa
 * provenance affichée est DIRECT dès qu'une preuve directe existe.
 * Totaux exacts AVANT pagination, par catégorie (`all`, `direct`,
 * `viaOperationOnly`), même requête de périmètre que la liste. Pagination
 * explicite (page, taille ≤ 200, `pageCount`, `hasMore`) : aucun plafond
 * silencieux ; `listAll…` parcourt toutes les pages.
 *
 * Exclus partout : documents supprimés ou non déposés ; Opérations invalidées
 * ou absorbées ; liens Opération ↔ fournisseur non actifs (retirés, refusés) ;
 * objets d'un autre compte (même si une jonction corrompue y pointe).
 * Le mot « Opération » n'est jamais un libellé : les identifiants sont
 * techniques, l'écran dit « événement de référence ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { documentTitleColumnsSql, documentTitleOf } from '@/lib/documents/document-title-source';
import { documentTypeLabelOrNull } from '@/lib/referential/user-facing-labels';
import type { GroupingRunner } from '@/services/business-operations/grouping/runner';

export const RELATIONS_CONTRACT_VERSION = 'relations-v1';
export const RELATIONS_DEFAULT_PAGE_SIZE = 50;
export const RELATIONS_MAX_PAGE_SIZE = 200;

export type RelationProvenance = 'DIRECT' | 'VIA_OPERATION';
export type RelationEntityKind = 'supplier' | 'equipment' | 'agenda_item';
export interface RelationEntity { kind: RelationEntityKind; id: number }
/** Filtre de provenance d'une liste : tout, objets avec preuve directe, objets visibles SEULEMENT par une Opération. */
export type RelationFilter = 'ALL' | 'DIRECT' | 'VIA_OPERATION_ONLY';

export interface RelationPageOptions { page?: number; pageSize?: number; provenance?: RelationFilter }

export interface RelationTotals { all: number; direct: number; viaOperationOnly: number }

export interface RelatedPage<T> {
  contract: typeof RELATIONS_CONTRACT_VERSION;
  items: T[];
  /** Nombre d'objets correspondant au filtre (avant pagination). */
  total: number;
  /** Décomptes séparés du périmètre complet (avant filtre et pagination). */
  totals: RelationTotals;
  page: number;
  pageSize: number;
  pageCount: number;
  hasMore: boolean;
}

/** Preuve directe : nature du lien, rôle, origine, état (toujours actif ici), preuve bornée (identifiants, confiance). */
export interface DirectRelation {
  kind: string;
  role: string | null;
  origin: string | null;
  state: 'ACTIVE';
  proof: Record<string, unknown>;
}

/** Contexte d'Opération : Opération source, rôle de l'entité DANS l'Opération, origine du lien, appartenance de l'objet. */
export interface OperationContext {
  operationId: number;
  role: string | null;
  origin: string | null;
  state: 'ACTIVE';
  /** Appartenance de l'objet à l'Opération (SOURCE / USER pour un document ; rôle PRINCIPAL / RELATED pour un élément). */
  membership: string[];
}

interface RelationBase {
  provenance: RelationProvenance;
  direct: DirectRelation[];
  viaOperations: OperationContext[];
}

export interface RelatedDocument extends RelationBase {
  id: number;
  publicId: string | null;
  title: string;
  documentType: string | null;
  documentTypeCode: string | null;
  documentTypeLabel: string | null;
  documentDate: string | null;
  mimeType: string | null;
  assetId: number | null;
  assetName: string | null;
  /** Bien ouvrable (ni archivé, ni verrouillé par l'offre) ou document sans bien. */
  available: boolean;
  webLinkUrl: string | null;
  createdAt: string | null;
}

export interface RelatedAgendaItem extends RelationBase {
  id: number;
  publicId: string | null;
  title: string;
  startDate: string | null;
  manualStatus: string | null;
  businessOperationId: number | null;
  operationRole: string | null;
}

export interface RelatedEquipment extends RelationBase {
  id: number;
  name: string;
  type: string | null;
  assetId: number;
  assetName: string;
  available: boolean;
}

export interface RelatedSupplier extends RelationBase {
  id: number;
  name: string;
  status: string;
}

export interface RelatedOperation {
  operationId: number;
  typeCode: string | null;
  status: string;
  provider: string | null;
  plannedDate: string | null;
  startDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
  /** Rôle de l'entité dans l'Opération (fournisseur : PROVIDER…, équipement : null, document : appartenance). */
  role: string | null;
  origin: string | null;
  documents: number;
}

type Row = Record<string, unknown>;

async function defaultRunner(): Promise<GroupingRunner> {
  const [{ pgClient }, { postgresRunner }] = await Promise.all([import('@/db'), import('@/services/business-operations/grouping/runner')]);
  return postgresRunner(pgClient);
}
const runnerOf = async (r?: GroupingRunner) => r ?? defaultRunner();

const BIEN_DISPONIBLE = (a: string) => `(${a}.status IS DISTINCT FROM 'ARCHIVED' AND coalesce(${a}.lock_state, 'NONE') = 'NONE')`;
/** Opération active (ni invalidée, ni absorbée) du compte $1. */
const OP_ACTIVE = (o: string) => `${o}.account_id = $1 AND ${o}.invalidated_at IS NULL AND ${o}.merged_into_operation_id IS NULL`;
/** Document consultable du compte $1. */
const DOC_VISIBLE = (f: string) => `${f}.account_id = $1 AND ${f}.deleted_at IS NULL AND (${f}.upload_status = 'COMPLETED' OR ${f}.upload_status IS NULL)`;

const jour = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const json = <T>(v: unknown, d: T): T => (v == null ? d : typeof v === 'string' ? JSON.parse(v) as T : v as T);

/** Options normalisées : page ≥ 1, 1 ≤ taille ≤ 200 (jamais une taille silencieusement ignorée : elle est renvoyée). */
export function normalizePage(o: RelationPageOptions = {}): { page: number; pageSize: number; provenance: RelationFilter } {
  const page = Number.isSafeInteger(o.page) && (o.page as number) > 0 ? (o.page as number) : 1;
  const raw = Number.isSafeInteger(o.pageSize) && (o.pageSize as number) > 0 ? (o.pageSize as number) : RELATIONS_DEFAULT_PAGE_SIZE;
  const provenance: RelationFilter = o.provenance === 'DIRECT' || o.provenance === 'VIA_OPERATION_ONLY' ? o.provenance : 'ALL';
  return { page, pageSize: Math.min(raw, RELATIONS_MAX_PAGE_SIZE), provenance };
}

/** Lecture des paramètres d'URL (`page`, `pageSize`, `provenance`) — même normalisation. */
export function pageOptionsFromSearch(params: URLSearchParams): RelationPageOptions {
  const n = (k: string) => (params.get(k) && /^\d{1,6}$/.test(params.get(k)!) ? Number(params.get(k)) : undefined);
  const p = params.get('provenance');
  return { page: n('page'), pageSize: n('pageSize'), provenance: p === 'DIRECT' || p === 'VIA_OPERATION_ONLY' ? p : 'ALL' };
}

const FILTER_SQL: Record<RelationFilter, string> = {
  ALL: 'TRUE',
  DIRECT: 'g.has_direct',
  VIA_OPERATION_ONLY: 'NOT g.has_direct',
};

/** Agrégation commune : une ligne par objet, preuves directes et contextes d'Opération. */
const AGG = `bool_or(r.provenance = 'DIRECT') AS has_direct,
  COALESCE(jsonb_agg(DISTINCT jsonb_build_object('kind', r.kind, 'role', r.role, 'origin', r.origin, 'state', 'ACTIVE', 'proof', r.proof))
           FILTER (WHERE r.provenance = 'DIRECT'), '[]'::jsonb) AS direct,
  COALESCE(jsonb_agg(DISTINCT jsonb_build_object('operationId', r.operation_id, 'role', r.role, 'origin', r.origin, 'state', 'ACTIVE', 'membership', r.membership))
           FILTER (WHERE r.provenance = 'VIA_OPERATION'), '[]'::jsonb) AS via`;

const base = (x: Row): RelationBase => {
  const direct = json<DirectRelation[]>(x.direct, []);
  const via = json<Array<OperationContext & { membership: unknown }>>(x.via, []).map((v) => ({
    ...v, operationId: Number(v.operationId), membership: Array.isArray(v.membership) ? (v.membership as string[]) : v.membership == null ? [] : [String(v.membership)],
  })).sort((a, b) => a.operationId - b.operationId);
  return { provenance: x.has_direct === true ? 'DIRECT' : 'VIA_OPERATION', direct, viaOperations: via };
};

// ── Périmètres (CTE `rel`) : $1 compte, $2 entité ───────────────────────────
// Colonnes : objet, provenance, operation_id, kind, role, origin, proof (jsonb), membership (text[]).

const REL_DOCUMENTS: Record<RelationEntityKind, string> = {
  supplier: `
    SELECT ds.document_id AS obj, 'DIRECT' AS provenance, NULL::bigint AS operation_id, 'DOCUMENT_SUPPLIER' AS kind,
           ds.role AS role, CASE WHEN ds.is_confirmed THEN 'USER_CONFIRMED' ELSE 'ANALYSIS' END AS origin,
           jsonb_build_object('confirmed', ds.is_confirmed, 'confidence', ds.confidence_score) AS proof, NULL::text[] AS membership
      FROM document_suppliers ds WHERE ds.supplier_id = $2
    UNION ALL
    SELECT d.file_id, 'VIA_OPERATION', l.operation_id, 'OPERATION_MEMBER', l.role, l.origin, NULL::jsonb, d.origins
      FROM business_operation_suppliers l
      JOIN business_operations o ON o.id = l.operation_id AND ${OP_ACTIVE('o')}
      JOIN business_operation_documents d ON d.operation_id = l.operation_id AND d.account_id = $1 AND d.active
     WHERE l.supplier_id = $2 AND l.account_id = $1 AND l.status = 'ACTIVE'`,
  equipment: `
    SELECT f0.id AS obj, 'DIRECT' AS provenance, NULL::bigint AS operation_id, 'LEGACY_EQUIPMENT_COLUMN' AS kind,
           NULL::text AS role, 'LEGACY_COLUMN' AS origin, '{}'::jsonb AS proof, NULL::text[] AS membership
      FROM asset_files f0 WHERE f0.account_id = $1 AND f0.equipment_id = $2
    UNION ALL
    SELECT l.file_id, 'DIRECT', NULL::bigint, 'DOCUMENT_EQUIPMENT', l.link_role, l.origin,
           jsonb_build_object('confidence', l.confidence), NULL::text[]
      FROM document_asset_links l
     WHERE l.account_id = $1 AND l.equipment_id = $2 AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY')
    UNION ALL
    SELECT d.file_id, 'VIA_OPERATION', l.operation_id, 'OPERATION_MEMBER', NULL::text, l.authority, NULL::jsonb, d.origins
      FROM business_operation_equipment_links l
      JOIN business_operations o ON o.id = l.operation_id AND ${OP_ACTIVE('o')}
      JOIN business_operation_documents d ON d.operation_id = l.operation_id AND d.account_id = $1 AND d.active
     WHERE l.equipment_id = $2 AND l.account_id = $1 AND l.active`,
  agenda_item: `
    SELECT l.asset_file_id AS obj, 'DIRECT' AS provenance, NULL::bigint AS operation_id, 'AGENDA_FILE_LINK' AS kind,
           NULL::text AS role,
           array_to_string(ARRAY(SELECT p FROM unnest(l.provenances) p WHERE p <> 'OPERATION_PRINCIPAL' ORDER BY p), ',') AS origin,
           jsonb_build_object('provenances', l.provenances) AS proof, NULL::text[] AS membership
      FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1
     WHERE l.agenda_item_id = $2
       AND (cardinality(l.provenances) = 0 OR l.provenances && ARRAY['MANUAL_DIRECT', 'AI_DIRECT']::text[])
    UNION ALL
    SELECT d.file_id, 'VIA_OPERATION', o.id, 'OPERATION_MEMBER', i.operation_role, NULL::text, NULL::jsonb, d.origins
      FROM agenda_items i
      JOIN business_operations o ON o.id = i.business_operation_id AND ${OP_ACTIVE('o')}
      JOIN business_operation_documents d ON d.operation_id = o.id AND d.account_id = $1 AND d.active
     WHERE i.id = $2 AND i.account_id = $1`,
};

const REL_AGENDA: Record<'supplier' | 'equipment', string> = {
  supplier: `
    SELECT l.agenda_item_id AS obj, 'DIRECT' AS provenance, NULL::bigint AS operation_id, 'AGENDA_SUPPLIER' AS kind,
           NULL::text AS role, l.provenance AS origin, jsonb_build_object('sourceDocumentId', l.source_document_id) AS proof, NULL::text[] AS membership
      FROM agenda_item_suppliers l WHERE l.supplier_id = $2 AND l.account_id = $1
    UNION ALL
    SELECT i.id, 'VIA_OPERATION', l.operation_id, 'OPERATION_ITEM', l.role, l.origin, NULL::jsonb, ARRAY[COALESCE(i.operation_role, 'RELATED')]
      FROM business_operation_suppliers l
      JOIN business_operations o ON o.id = l.operation_id AND ${OP_ACTIVE('o')}
      JOIN agenda_items i ON i.business_operation_id = l.operation_id AND i.account_id = $1
     WHERE l.supplier_id = $2 AND l.account_id = $1 AND l.status = 'ACTIVE'`,
  equipment: `
    SELECT l.agenda_item_id AS obj, 'DIRECT' AS provenance, NULL::bigint AS operation_id, 'AGENDA_EQUIPMENT' AS kind,
           NULL::text AS role, NULL::text AS origin, '{}'::jsonb AS proof, NULL::text[] AS membership
      FROM agenda_equipment_links l WHERE l.equipment_id = $2
    UNION ALL
    SELECT i.id, 'VIA_OPERATION', l.operation_id, 'OPERATION_ITEM', NULL::text, l.authority, NULL::jsonb, ARRAY[COALESCE(i.operation_role, 'RELATED')]
      FROM business_operation_equipment_links l
      JOIN business_operations o ON o.id = l.operation_id AND ${OP_ACTIVE('o')}
      JOIN agenda_items i ON i.business_operation_id = l.operation_id AND i.account_id = $1
     WHERE l.equipment_id = $2 AND l.account_id = $1 AND l.active`,
};

const REL_SUPPLIER_EQUIPMENTS = `
    SELECT es.equipment_id AS obj, 'DIRECT' AS provenance, NULL::bigint AS operation_id, 'EQUIPMENT_SUPPLIER' AS kind,
           es.relationship_type AS role, es.source_type AS origin, jsonb_build_object('isPrimary', es.is_primary, 'sourceDocumentId', es.source_document_id) AS proof,
           NULL::text[] AS membership
      FROM equipment_suppliers es WHERE es.supplier_id = $2
    UNION ALL
    SELECT el.equipment_id, 'VIA_OPERATION', l.operation_id, 'OPERATION_EQUIPMENT', l.role, l.origin, NULL::jsonb, ARRAY[el.authority]
      FROM business_operation_suppliers l
      JOIN business_operations o ON o.id = l.operation_id AND ${OP_ACTIVE('o')}
      JOIN business_operation_equipment_links el ON el.operation_id = l.operation_id AND el.account_id = $1 AND el.active
     WHERE l.supplier_id = $2 AND l.account_id = $1 AND l.status = 'ACTIVE'`;

const REL_EQUIPMENT_SUPPLIERS = `
    SELECT es.supplier_id AS obj, 'DIRECT' AS provenance, NULL::bigint AS operation_id, 'EQUIPMENT_SUPPLIER' AS kind,
           es.relationship_type AS role, es.source_type AS origin, jsonb_build_object('isPrimary', es.is_primary, 'sourceDocumentId', es.source_document_id) AS proof,
           NULL::text[] AS membership
      FROM equipment_suppliers es WHERE es.equipment_id = $2
    UNION ALL
    SELECT l.supplier_id, 'VIA_OPERATION', l.operation_id, 'OPERATION_SUPPLIER', l.role, l.origin, NULL::jsonb, ARRAY[el.authority]
      FROM business_operation_equipment_links el
      JOIN business_operations o ON o.id = el.operation_id AND ${OP_ACTIVE('o')}
      JOIN business_operation_suppliers l ON l.operation_id = el.operation_id AND l.account_id = $1 AND l.status = 'ACTIVE'
     WHERE el.equipment_id = $2 AND el.account_id = $1 AND el.active`;

/** Entité présente dans le compte ? (fournisseur non supprimé, équipement d'un bien du compte, élément du compte). */
async function entityInAccount(r: GroupingRunner, accountId: number, e: RelationEntity): Promise<boolean> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !Number.isSafeInteger(e.id) || e.id <= 0) return false;
  const q = e.kind === 'supplier'
    ? `SELECT 1 FROM suppliers WHERE id = $2 AND account_id = $1 AND status <> 'deleted'`
    : e.kind === 'equipment'
      ? `SELECT 1 FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE e.id = $2`
      : `SELECT 1 FROM agenda_items WHERE id = $2 AND account_id = $1`;
  return (await r.q(q, [accountId, e.id])).length > 0;
}

/** Page générique : `rel` (périmètre), `visible` (jointure de l'objet, alias `x`), `select` / `order` de l'objet. */
async function pageOf(
  r: GroupingRunner, accountId: number, entityId: number, o: RelationPageOptions,
  spec: { rel: string; visible: string; select: string; order: string },
): Promise<{ rows: Row[]; total: number; totals: RelationTotals; page: number; pageSize: number }> {
  const { page, pageSize, provenance } = normalizePage(o);
  const cte = `WITH rel AS (${spec.rel}),
    g AS (SELECT r.obj, ${AGG} FROM rel r ${spec.visible.replace(/\{obj\}/g, 'r.obj')} GROUP BY r.obj)`;
  const [t] = await r.q<{ n_all: number; direct: number; via_only: number }>(
    `${cte} SELECT count(*)::int AS n_all, count(*) FILTER (WHERE g.has_direct)::int AS direct, count(*) FILTER (WHERE NOT g.has_direct)::int AS via_only FROM g`,
    [accountId, entityId]);
  const totals: RelationTotals = { all: Number(t?.n_all ?? 0), direct: Number(t?.direct ?? 0), viaOperationOnly: Number(t?.via_only ?? 0) };
  const total = provenance === 'ALL' ? totals.all : provenance === 'DIRECT' ? totals.direct : totals.viaOperationOnly;
  const rows = total === 0 ? [] : await r.q<Row>(
    `${cte} SELECT ${spec.select}, g.has_direct, g.direct, g.via
       FROM g ${spec.visible.replace(/\{obj\}/g, 'g.obj').replace(/^\s*JOIN/, 'JOIN')}
      WHERE ${FILTER_SQL[provenance]}
      ORDER BY ${spec.order}
      LIMIT $3 OFFSET $4`, [accountId, entityId, pageSize, (page - 1) * pageSize]);
  return { rows, total, totals, page, pageSize };
}

const wrap = <T>(p: { rows: Row[]; total: number; totals: RelationTotals; page: number; pageSize: number }, map: (x: Row) => T): RelatedPage<T> => {
  const pageCount = Math.max(1, Math.ceil(p.total / p.pageSize));
  return { contract: RELATIONS_CONTRACT_VERSION, items: p.rows.map(map), total: p.total, totals: p.totals, page: p.page, pageSize: p.pageSize, pageCount, hasMore: p.page < pageCount && p.total > p.page * p.pageSize };
};

// ── Documents ───────────────────────────────────────────────────────────────

const DOC_VISIBLE_JOIN = `JOIN asset_files x ON x.id = {obj} AND ${DOC_VISIBLE('x')}`;
const DOC_SELECT = `x.id, x.public_id::text AS public_id, ${documentTitleColumnsSql('x')}, x.document_type, x.retained_function_code, x.document_type_code,
  x.document_date, x.mime_type, x.asset_id, x.web_link_url, x.created_at,
  (SELECT a.name FROM assets a WHERE a.id = x.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL) AS asset_name,
  (x.asset_id IS NULL OR EXISTS (SELECT 1 FROM assets a WHERE a.id = x.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL AND ${BIEN_DISPONIBLE('a')})) AS available`;
const DOC_ORDER = 'x.document_date DESC NULLS LAST, x.id DESC';

const toDocument = (x: Row): RelatedDocument => ({
  id: Number(x.id), publicId: (x.public_id as string | null) ?? null, title: documentTitleOf(x),
  documentType: ((x.retained_function_code ?? x.document_type) as string | null) ?? null,
  documentTypeCode: (x.document_type_code as string | null) ?? null, documentTypeLabel: documentTypeLabelOrNull(x.document_type_code as string | null),
  documentDate: jour(x.document_date), mimeType: (x.mime_type as string | null) ?? null,
  assetId: x.asset_id == null ? null : Number(x.asset_id), assetName: (x.asset_name as string | null) ?? null, available: x.available === true,
  webLinkUrl: (x.web_link_url as string | null) ?? null, createdAt: iso(x.created_at),
  ...base(x),
});

/**
 * Documents d'une entité (fournisseur, équipement, élément d'Agenda) : liens
 * DIRECTS et documents des Opérations associées (VIA_OPERATION), une fois
 * chacun. `null` : entité absente du compte.
 */
export async function listEntityDocuments(accountId: number, entity: RelationEntity, o: RelationPageOptions = {}, runner?: GroupingRunner): Promise<RelatedPage<RelatedDocument> | null> {
  const r = await runnerOf(runner);
  if (!(await entityInAccount(r, accountId, entity))) return null;
  return wrap(await pageOf(r, accountId, entity.id, o, { rel: REL_DOCUMENTS[entity.kind], visible: DOC_VISIBLE_JOIN, select: DOC_SELECT, order: DOC_ORDER }), toDocument);
}

// ── Agenda ──────────────────────────────────────────────────────────────────

const AGENDA_VISIBLE_JOIN = `JOIN agenda_items x ON x.id = {obj} AND x.account_id = $1`;
const AGENDA_SELECT = `x.id, x.public_id::text AS public_id, x.title, x.start_date, x.manual_status, x.business_operation_id, x.operation_role`;
const AGENDA_ORDER = 'x.start_date DESC NULLS LAST, x.id DESC';
const toAgenda = (x: Row): RelatedAgendaItem => ({
  id: Number(x.id), publicId: (x.public_id as string | null) ?? null, title: String(x.title ?? ''), startDate: jour(x.start_date),
  manualStatus: (x.manual_status as string | null) ?? null,
  businessOperationId: x.business_operation_id == null ? null : Number(x.business_operation_id), operationRole: (x.operation_role as string | null) ?? null,
  ...base(x),
});

/** Éléments d'Agenda d'un fournisseur ou d'un équipement : liens directs et éléments des Opérations associées. */
export async function listEntityAgendaItems(accountId: number, entity: RelationEntity & { kind: 'supplier' | 'equipment' }, o: RelationPageOptions = {}, runner?: GroupingRunner): Promise<RelatedPage<RelatedAgendaItem> | null> {
  const r = await runnerOf(runner);
  if (!(await entityInAccount(r, accountId, entity))) return null;
  return wrap(await pageOf(r, accountId, entity.id, o, { rel: REL_AGENDA[entity.kind], visible: AGENDA_VISIBLE_JOIN, select: AGENDA_SELECT, order: AGENDA_ORDER }), toAgenda);
}

// ── Équipements / fournisseurs croisés ──────────────────────────────────────

const toEquipment = (x: Row): RelatedEquipment => ({
  id: Number(x.id), name: String(x.name ?? ''), type: (x.type as string | null) ?? null, assetId: Number(x.asset_id), assetName: String(x.asset_name ?? ''),
  available: x.available === true, ...base(x),
});
const toSupplier = (x: Row): RelatedSupplier => ({ id: Number(x.id), name: String(x.name ?? ''), status: String(x.status ?? ''), ...base(x) });

/** Équipements d'un fournisseur : liens directs (`equipment_suppliers`) et équipements des Opérations du fournisseur. */
export async function listSupplierEquipments(accountId: number, supplierId: number, o: RelationPageOptions = {}, runner?: GroupingRunner): Promise<RelatedPage<RelatedEquipment> | null> {
  const r = await runnerOf(runner);
  if (!(await entityInAccount(r, accountId, { kind: 'supplier', id: supplierId }))) return null;
  return wrap(await pageOf(r, accountId, supplierId, o, {
    rel: REL_SUPPLIER_EQUIPMENTS,
    visible: `JOIN equipments x ON x.id = {obj} AND x.archived_at IS NULL JOIN assets xa ON xa.id = x.asset_id AND xa.account_id = $1 AND xa.deleted_at IS NULL`,
    select: `x.id, x.name, x.type, x.asset_id, xa.name AS asset_name, ${BIEN_DISPONIBLE('xa')} AS available`,
    order: 'x.name, x.id',
  }), toEquipment);
}

/** Fournisseurs d'un équipement : liens directs et fournisseurs des Opérations de l'équipement. */
export async function listEquipmentSuppliers(accountId: number, equipmentId: number, o: RelationPageOptions = {}, runner?: GroupingRunner): Promise<RelatedPage<RelatedSupplier> | null> {
  const r = await runnerOf(runner);
  if (!(await entityInAccount(r, accountId, { kind: 'equipment', id: equipmentId }))) return null;
  return wrap(await pageOf(r, accountId, equipmentId, o, {
    rel: REL_EQUIPMENT_SUPPLIERS,
    visible: `JOIN suppliers x ON x.id = {obj} AND x.account_id = $1 AND x.status <> 'deleted'`,
    select: 'x.id, x.name, x.status',
    order: 'x.name, x.id',
  }), toSupplier);
}

// ── Opérations d'une entité ─────────────────────────────────────────────────

const OPS_SQL: Record<RelationEntityKind | 'document', string> = {
  supplier: `SELECT l.operation_id AS id, l.role, l.origin FROM business_operation_suppliers l WHERE l.supplier_id = $2 AND l.account_id = $1 AND l.status = 'ACTIVE'`,
  equipment: `SELECT l.operation_id AS id, NULL::text AS role, l.authority AS origin FROM business_operation_equipment_links l WHERE l.equipment_id = $2 AND l.account_id = $1 AND l.active`,
  agenda_item: `SELECT i.business_operation_id AS id, i.operation_role AS role, i.operation_role_origin AS origin FROM agenda_items i WHERE i.id = $2 AND i.account_id = $1 AND i.business_operation_id IS NOT NULL`,
  document: `SELECT d.operation_id AS id, array_to_string(d.origins, ',') AS role, NULL::text AS origin FROM business_operation_documents d WHERE d.file_id = $2 AND d.account_id = $1 AND d.active`,
};

/** Opérations ACTIVES associées à une entité (navigation), avec le rôle de l'entité et le nombre de documents. Exhaustif. */
export async function listEntityOperations(accountId: number, entity: RelationEntity | { kind: 'document'; id: number }, runner?: GroupingRunner): Promise<RelatedOperation[] | null> {
  const r = await runnerOf(runner);
  if (entity.kind === 'document') {
    if (!(await r.q(`SELECT 1 FROM asset_files f WHERE f.id = $2 AND ${DOC_VISIBLE('f')}`, [accountId, entity.id])).length) return null;
  } else if (!(await entityInAccount(r, accountId, entity))) return null;
  const rows = await r.q<Row>(
    `WITH l AS (${OPS_SQL[entity.kind]})
     SELECT o.id, o.type_code, o.status, o.provider, o.planned_date::text AS planned_date, o.start_date::text AS start_date,
            o.realized_date::text AS realized_date, o.end_date::text AS end_date,
            string_agg(DISTINCT l.role, ',') AS role, string_agg(DISTINCT l.origin, ',') AS origin,
            (SELECT count(*)::int FROM business_operation_documents d JOIN asset_files f ON f.id = d.file_id AND ${DOC_VISIBLE('f')}
              WHERE d.operation_id = o.id AND d.account_id = $1 AND d.active) AS documents
       FROM l JOIN business_operations o ON o.id = l.id AND ${OP_ACTIVE('o')}
      GROUP BY o.id ORDER BY COALESCE(o.realized_date, o.start_date, o.planned_date) DESC NULLS LAST, o.id DESC`, [accountId, entity.id]);
  return rows.map((x) => ({
    operationId: Number(x.id), typeCode: (x.type_code as string | null) ?? null, status: String(x.status), provider: (x.provider as string | null) ?? null,
    plannedDate: jour(x.planned_date), startDate: jour(x.start_date), realizedDate: jour(x.realized_date), endDate: jour(x.end_date),
    role: (x.role as string | null) ?? null, origin: (x.origin as string | null) ?? null, documents: Number(x.documents ?? 0),
  }));
}

// ── Document ────────────────────────────────────────────────────────────────

export interface DocumentRelations {
  contract: typeof RELATIONS_CONTRACT_VERSION;
  documentId: number;
  /** Rattachements PROUVÉS du document (preuve propre ou décision de l'utilisateur). */
  direct: {
    suppliers: Array<{ supplierId: number; name: string; role: string | null; confirmed: boolean; confidence: number | null }>;
    assets: Array<{ assetId: number; name: string; role: string; origin: string }>;
    equipments: Array<{ equipmentId: number; name: string; assetId: number; role: string; origin: string }>;
    rooms: Array<{ roomId: number; name: string; assetId: number; role: string; origin: string }>;
    agendaItems: Array<{ id: number; title: string; provenances: string[] }>;
  };
  /** Opérations dont le document est membre (un document multi-Opérations reste unique), avec leurs entités — contexte, jamais lien direct. */
  operations: Array<{
    operationId: number; typeCode: string | null; status: string; membership: string[];
    suppliers: Array<{ supplierId: number; name: string; role: string; origin: string }>;
    equipments: Array<{ equipmentId: number; name: string; assetId: number }>;
    agendaItems: Array<{ id: number; title: string; role: string | null; documentLinked: boolean }>;
  }>;
}

/** Relations d'un document : rattachements directs ET Opérations, sans confondre liens hérités et liens prouvés. `null` : absent du compte. */
export async function getDocumentRelations(accountId: number, fileId: number, runner?: GroupingRunner): Promise<DocumentRelations | null> {
  const r = await runnerOf(runner);
  if (!Number.isSafeInteger(fileId) || fileId <= 0) return null;
  const [f] = await r.q<{ id: number; equipment_id: number | null }>(`SELECT f.id, f.equipment_id FROM asset_files f WHERE f.id = $2 AND ${DOC_VISIBLE('f')}`, [accountId, fileId]);
  if (!f) return null;
  const suppliers = await r.q<Row>(
    `SELECT s.id, s.name, ds.role, ds.is_confirmed, ds.confidence_score FROM document_suppliers ds
       JOIN suppliers s ON s.id = ds.supplier_id AND s.account_id = $1 AND s.status <> 'deleted'
      WHERE ds.document_id = $2 ORDER BY s.name, s.id`, [accountId, fileId]);
  const links = await r.q<Row>(
    `SELECT l.asset_id, a.name AS asset_name, l.equipment_id, e.name AS equipment_name, e.asset_id AS equipment_asset_id,
            l.substructure_id, s.name AS room_name, s.asset_id AS room_asset_id, l.link_role, l.origin
       FROM document_asset_links l
       LEFT JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
       LEFT JOIN equipments e ON e.id = l.equipment_id AND EXISTS (SELECT 1 FROM assets ea WHERE ea.id = e.asset_id AND ea.account_id = $1)
       LEFT JOIN substructures s ON s.id = l.substructure_id AND EXISTS (SELECT 1 FROM assets sa WHERE sa.id = s.asset_id AND sa.account_id = $1)
      WHERE l.file_id = $2 AND l.account_id = $1 AND l.status = 'ACTIVE' ORDER BY l.id`, [accountId, fileId]);
  const direct: DocumentRelations['direct'] = {
    suppliers: suppliers.map((s) => ({ supplierId: Number(s.id), name: String(s.name), role: (s.role as string | null) ?? null, confirmed: s.is_confirmed === true, confidence: s.confidence_score == null ? null : Number(s.confidence_score) })),
    assets: [], equipments: [], rooms: [], agendaItems: [],
  };
  for (const l of links) {
    if (l.substructure_id != null && l.room_name != null) direct.rooms.push({ roomId: Number(l.substructure_id), name: String(l.room_name), assetId: Number(l.room_asset_id), role: String(l.link_role), origin: String(l.origin) });
    else if (l.equipment_id != null && l.equipment_name != null) direct.equipments.push({ equipmentId: Number(l.equipment_id), name: String(l.equipment_name), assetId: Number(l.equipment_asset_id), role: String(l.link_role), origin: String(l.origin) });
    else if (l.asset_id != null && l.asset_name != null) direct.assets.push({ assetId: Number(l.asset_id), name: String(l.asset_name), role: String(l.link_role), origin: String(l.origin) });
  }
  if (f.equipment_id != null && !direct.equipments.some((e) => e.equipmentId === Number(f.equipment_id))) {
    const [e] = await r.q<Row>(`SELECT e.id, e.name, e.asset_id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE e.id = $2`, [accountId, f.equipment_id]);
    if (e) direct.equipments.push({ equipmentId: Number(e.id), name: String(e.name), assetId: Number(e.asset_id), role: 'PRIMARY', origin: 'LEGACY_COLUMN' });
  }
  const agenda = await r.q<Row>(
    `SELECT i.id, i.title, l.provenances FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1
      WHERE l.asset_file_id = $2 ORDER BY i.start_date NULLS LAST, i.id`, [accountId, fileId]);
  for (const a of agenda) {
    const prov = json<string[]>(a.provenances, []);
    if (prov.length === 0 || prov.includes('MANUAL_DIRECT') || prov.includes('AI_DIRECT')) direct.agendaItems.push({ id: Number(a.id), title: String(a.title), provenances: prov });
  }
  const ops = await r.q<Row>(
    `SELECT o.id, o.type_code, o.status, d.origins FROM business_operation_documents d
       JOIN business_operations o ON o.id = d.operation_id AND ${OP_ACTIVE('o')}
      WHERE d.file_id = $2 AND d.account_id = $1 AND d.active ORDER BY o.id`, [accountId, fileId]);
  const operations: DocumentRelations['operations'] = [];
  for (const o of ops) {
    const id = Number(o.id);
    const [sup, eqs, items] = [
      await r.q<Row>(`SELECT s.id, s.name, l.role, l.origin FROM business_operation_suppliers l JOIN suppliers s ON s.id = l.supplier_id AND s.account_id = $1 AND s.status <> 'deleted'
                       WHERE l.operation_id = $2 AND l.account_id = $1 AND l.status = 'ACTIVE' ORDER BY l.role DESC, s.name, s.id`, [accountId, id]),
      await r.q<Row>(`SELECT e.id, e.name, e.asset_id FROM business_operation_equipment_links l JOIN equipments e ON e.id = l.equipment_id
                       JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE l.operation_id = $2 AND l.account_id = $1 AND l.active ORDER BY e.name, e.id`, [accountId, id]),
      await r.q<Row>(`SELECT i.id, i.title, i.operation_role,
                             EXISTS (SELECT 1 FROM agenda_file_links fl WHERE fl.agenda_item_id = i.id AND fl.asset_file_id = $3) AS linked
                        FROM agenda_items i WHERE i.business_operation_id = $2 AND i.account_id = $1 ORDER BY i.start_date NULLS LAST, i.id`, [accountId, id, fileId]),
    ];
    operations.push({
      operationId: id, typeCode: (o.type_code as string | null) ?? null, status: String(o.status), membership: json<string[]>(o.origins, []),
      suppliers: sup.map((s) => ({ supplierId: Number(s.id), name: String(s.name), role: String(s.role), origin: String(s.origin) })),
      equipments: eqs.map((e) => ({ equipmentId: Number(e.id), name: String(e.name), assetId: Number(e.asset_id) })),
      agendaItems: items.map((i) => ({ id: Number(i.id), title: String(i.title), role: (i.operation_role as string | null) ?? null, documentLinked: i.linked === true })),
    });
  }
  return { contract: RELATIONS_CONTRACT_VERSION, documentId: fileId, direct, operations };
}

// ── Compteurs ───────────────────────────────────────────────────────────────

export interface EntityRelationCounts {
  contract: typeof RELATIONS_CONTRACT_VERSION;
  documents: RelationTotals;
  agendaItems: RelationTotals | null;
  equipments: RelationTotals | null;
  suppliers: RelationTotals | null;
  operations: number;
}

/** Compteurs d'une entité : MÊMES périmètres que les listes (totaux exacts, par catégorie). `null` : absente du compte. */
export async function countEntityRelations(accountId: number, entity: RelationEntity, runner?: GroupingRunner): Promise<EntityRelationCounts | null> {
  const r = await runnerOf(runner);
  if (!(await entityInAccount(r, accountId, entity))) return null;
  const one = { page: 1, pageSize: 1 };
  const docs = (await listEntityDocuments(accountId, entity, one, r))!;
  const agenda = entity.kind === 'agenda_item' ? null : (await listEntityAgendaItems(accountId, entity as RelationEntity & { kind: 'supplier' | 'equipment' }, one, r))!.totals;
  const equipments = entity.kind === 'supplier' ? (await listSupplierEquipments(accountId, entity.id, one, r))!.totals : null;
  const suppliers = entity.kind === 'equipment' ? (await listEquipmentSuppliers(accountId, entity.id, one, r))!.totals : null;
  const ops = (await listEntityOperations(accountId, entity, r)) ?? [];
  return { contract: RELATIONS_CONTRACT_VERSION, documents: docs.totals, agendaItems: agenda, equipments, suppliers, operations: ops.length };
}

/** Parcours EXHAUSTIF de toutes les pages (aucun plafond) — pour les écrans qui affichent la liste complète. */
export async function listAll<T>(fetchPage: (page: number) => Promise<RelatedPage<T> | null>): Promise<RelatedPage<T> | null> {
  const first = await fetchPage(1);
  if (!first) return null;
  const items = [...first.items];
  for (let p = 2; p <= first.pageCount; p++) {
    const next = await fetchPage(p);
    if (!next) break;
    items.push(...next.items);
  }
  return { ...first, items, page: 1, pageSize: Math.max(first.pageSize, items.length), pageCount: 1, hasMore: false };
}

// ── Fiche fournisseur (point d'appel de 109B) ──────────────────────────────

/**
 * Documents d'un fournisseur pour sa fiche : documents DIRECTEMENT liés
 * (émetteur légal, `document_suppliers`) et documents des Opérations
 * associées (VIA_OPERATION, présentés comme documents de l'Opération — pas
 * comme émis par ce fournisseur). `null` : fournisseur absent du compte.
 */
export function listSupplierDocuments(accountId: number, supplierId: number, o: RelationPageOptions = {}, runner?: GroupingRunner): Promise<RelatedPage<RelatedDocument> | null> {
  return listEntityDocuments(accountId, { kind: 'supplier', id: supplierId }, o, runner);
}

/** Événements d'Agenda d'un fournisseur (liens directs `agenda_item_suppliers` + éléments des Opérations associées). */
export function listSupplierAgendaItems(accountId: number, supplierId: number, o: RelationPageOptions = {}, runner?: GroupingRunner): Promise<RelatedPage<RelatedAgendaItem> | null> {
  return listEntityAgendaItems(accountId, { kind: 'supplier', id: supplierId }, o, runner);
}

/** Opérations associées à un fournisseur (navigation), rôle du fournisseur dans chacune. */
export function listSupplierOperations(accountId: number, supplierId: number, runner?: GroupingRunner): Promise<RelatedOperation[] | null> {
  return listEntityOperations(accountId, { kind: 'supplier', id: supplierId }, runner);
}

/** Compteurs de la fiche fournisseur (documents, Agenda, équipements, Opérations), mêmes périmètres que les listes. */
export function countSupplierRelations(accountId: number, supplierId: number, runner?: GroupingRunner): Promise<EntityRelationCounts | null> {
  return countEntityRelations(accountId, { kind: 'supplier', id: supplierId }, runner);
}
