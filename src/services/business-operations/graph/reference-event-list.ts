/**
 * Carte Trello #806, volet B §8 — LECTURE de la LISTE DES OPÉRATIONS du compte
 * (page `/agenda/evenements-reference`, route `GET /api/evenements-reference`).
 *
 * Lecture seule, aucune IA, aucune écriture. Bornée au compte dans CHAQUE
 * sous-requête. Les règles sont celles de la fiche — aucune n'est dupliquée :
 *   · titre       : `referenceEventTitleFromFacts` (règle unique de la fiche) ;
 *   · date        : date de présentation (`presentationDateOfRow`, CDC §11) ;
 *   · montant     : net indicatif du moteur existant (`indicativeNetCents`) —
 *                   devis exclus, devise sans contre-valeur non convertie ;
 *   · opérations  : actives seulement (ni supprimées, ni regroupées).
 *
 * AUCUNE LIMITE SILENCIEUSE : toutes les opérations actives du compte sont
 * lues, filtrées et triées, puis la page demandée est rendue avec le nombre
 * total. Le titre et la date sont calculés (règles pures) : le filtre de texte
 * et le tri se font donc après la lecture, sur l'ensemble — jamais sur une
 * partie tronquée. Le filtre par type et par bien est fait en base.
 */
import type postgres from 'postgres';
import { BUSINESS_OPERATION_TYPE_CODES, type FinancialComponentKind } from '../model';
import {
  OPERATION_LIST_TYPE_NONE, compareOperationListItems, operationListHaystack, operationListMatches, paginateOperationList,
  type OperationListItem, type OperationListPage, type OperationListQuery,
} from '@/lib/reference-events/operation-list';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;
const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const textes = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(txt).filter((x): x is string => x !== null) : []);

function jsonArray(v: unknown): Array<Record<string, unknown>> {
  let x: unknown = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { x = null; } }
  return Array.isArray(x) ? (x as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object') : [];
}

/** Liste paginée des opérations ACTIVES du compte qui répondent à la demande. */
export async function readOperationList(accountId: number, query: OperationListQuery): Promise<OperationListPage> {
  const { referenceEventLabel } = await import('@/services/documents/business-period-surfaces');
  const types = BUSINESS_OPERATION_TYPE_CODES.map((code) => ({ code: code as string, label: referenceEventLabel({ typeCode: code, technicalLabel: null }) }));
  const vide: OperationListPage = { items: [], total: 0, totalAll: 0, page: 1, pageSize: query.pageSize, pages: 1, query: { ...query, page: 1 }, types, assets: [] };
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return vide;
  const sql = await sqlClient();
  const { REFERENCE_EVENT_SEARCH_SQL, referenceEventSearchFactsOf } = await import('./reference-event-page');
  const { indicativeNetCents } = await import('../diagnostics/model');

  // Filtres faits en base : type (code du référentiel, ou « non précisé ») et bien. `$1` = compte (sous-requêtes).
  const typeConnu = query.type !== null && (BUSINESS_OPERATION_TYPE_CODES as readonly string[]).includes(query.type) ? query.type : null;
  const sansType = query.type === OPERATION_LIST_TYPE_NONE;
  const [rows, totalRows, biens] = (await Promise.all([
    sql.unsafe(
      `SELECT o.id, o.type_code, o.technical_label, o.provider,
              ${REFERENCE_EVENT_SEARCH_SQL.presentationFacts},
              ${REFERENCE_EVENT_SEARCH_SQL.assetNames} AS asset_names,
              ${REFERENCE_EVENT_SEARCH_SQL.supplierNames} AS supplier_names,
              ${REFERENCE_EVENT_SEARCH_SQL.declarations} AS declarations,
              ${REFERENCE_EVENT_SEARCH_SQL.foundingDeclaration} AS founding_declaration,
              ${REFERENCE_EVENT_SEARCH_SQL.references} AS reference_values,
              ${REFERENCE_EVENT_SEARCH_SQL.firstDocument} AS first_document,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name, a.id), '[]'::jsonb)
                 FROM (SELECT DISTINCT a.id, a.name FROM business_operation_asset_links l
                         JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
                        WHERE l.account_id = $1 AND l.operation_id = o.id AND l.active) a) AS biens,
              (SELECT array_agg(DISTINCT s.name) FROM business_operation_room_links l
                 JOIN substructures s ON s.id = l.substructure_id
                 JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
                WHERE l.account_id = $1 AND l.operation_id = o.id AND l.active) AS pieces,
              (SELECT array_agg(DISTINCT e.name) FROM business_operation_equipment_links l
                 JOIN equipments e ON e.id = l.equipment_id AND e.archived_at IS NULL
                 JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
                WHERE l.account_id = $1 AND l.operation_id = o.id AND l.active) AS equipements,
              (SELECT array_agg(COALESCE(f.retained_title, f.web_link_title, f.original_filename, f.filename))
                 FROM business_operation_documents d
                 JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
                WHERE d.account_id = $1 AND d.operation_id = o.id AND d.active) AS titres_documents,
              (SELECT count(DISTINCT d.file_id)::int FROM business_operation_documents d
                 JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
                WHERE d.account_id = $1 AND d.operation_id = o.id AND d.active) AS documents,
              (SELECT count(DISTINCT g.agenda_item_id)::int FROM business_operation_agenda_links g
                 JOIN agenda_items i ON i.id = g.agenda_item_id AND i.account_id = g.account_id
                WHERE g.account_id = $1 AND g.operation_id = o.id AND g.state = 'ACTIVE') AS evenements,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', c.kind, 'amountMinor', c.amount_minor, 'currency', c.currency, 'amountEurCents', c.amount_eur_cents) ORDER BY c.id), '[]'::jsonb)
                 FROM business_operation_financial_components c
                WHERE c.account_id = $1 AND c.operation_id = o.id AND c.active) AS composantes,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'type_code', x.type_code, 'technical_label', x.technical_label, 'provider', x.provider) ORDER BY x.id), '[]'::jsonb)
                 FROM business_operation_relations rel
                 JOIN business_operations x ON x.account_id = rel.account_id AND x.type_code = 'CONTRACT'
                  AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL
                  AND x.id = CASE WHEN rel.from_operation_id = o.id THEN rel.to_operation_id ELSE rel.from_operation_id END
                WHERE rel.account_id = $1 AND rel.state = 'ACTIVE' AND (rel.from_operation_id = o.id OR rel.to_operation_id = o.id)) AS contrats
         FROM business_operations o
        WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
          AND ($2::text IS NULL OR o.type_code = $2)
          AND (NOT $3::boolean OR o.type_code IS NULL)
          AND ($4::int IS NULL OR EXISTS (SELECT 1 FROM business_operation_asset_links l
                                           JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
                                          WHERE l.account_id = $1 AND l.operation_id = o.id AND l.active AND l.asset_id = $4))
        ORDER BY o.id DESC`,
      [accountId, typeConnu, sansType, query.assetId] as never[]),
    sql.unsafe(
      `SELECT count(*)::int AS n FROM business_operations o
        WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`, [accountId] as never[]),
    sql.unsafe(
      `SELECT DISTINCT a.id, a.name FROM business_operation_asset_links l
         JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE l.account_id = $1 AND l.active ORDER BY a.name, a.id`, [accountId] as never[]),
  ])) as unknown as [Row[], Row[], Row[]];

  const lignes: Array<{ item: OperationListItem; haystack: string }> = [];
  for (const r of rows) {
    const f = await referenceEventSearchFactsOf(r);
    const comps = jsonArray(r.composantes).map((c) => ({
      kind: String(c.kind) as FinancialComponentKind, amountMinor: Number(c.amountMinor ?? 0), currency: String(c.currency ?? ''),
      amountEurCents: c.amountEurCents === null || c.amountEurCents === undefined ? null : Number(c.amountEurCents), active: true,
    }));
    const item: OperationListItem = {
      id: f.id, title: f.title, typeCode: f.typeCode,
      typeLabel: f.typeCode ? referenceEventLabel({ typeCode: f.typeCode, technicalLabel: null }) : null,
      date: f.ownDate,
      assets: jsonArray(r.biens).map((b) => ({ id: Number(b.id), name: String(b.name ?? '') })),
      rooms: textes(r.pieces).sort((a, b) => a.localeCompare(b, 'fr')),
      equipments: textes(r.equipements).sort((a, b) => a.localeCompare(b, 'fr')),
      suppliers: f.supplierNames, provider: f.provider,
      documentCount: Number(r.documents ?? 0), agendaItemCount: Number(r.evenements ?? 0),
      contracts: jsonArray(r.contrats).map((c) => ({
        id: Number(c.id), label: referenceEventLabel({ typeCode: txt(c.type_code), technicalLabel: txt(c.technical_label), provider: txt(c.provider) }),
      })),
      netCents: indicativeNetCents(comps).cents,
      unconvertedCount: comps.filter((c) => c.kind !== 'FORECAST_COST' && c.currency !== 'EUR' && c.amountEurCents === null).length,
    };
    lignes.push({ item, haystack: operationListHaystack(item, [...textes(r.titres_documents), ...f.references, ...f.declarations]) });
  }

  const retenues = lignes
    .filter((l) => operationListMatches(l.haystack, query.q))
    .filter((l) => (query.state === 'DATED' ? l.item.date !== null : query.state === 'UNDATED' ? l.item.date === null
      : query.state === 'NO_DOCUMENT' ? l.item.documentCount === 0 : true))
    .map((l) => l.item)
    .sort(compareOperationListItems(query.sort));
  const page = paginateOperationList(retenues, query.page, query.pageSize);
  return {
    items: page.items, total: retenues.length, totalAll: Number(totalRows[0]?.n ?? 0), page: page.page, pageSize: query.pageSize, pages: page.pages,
    query: { ...query, page: page.page }, types,
    assets: biens.map((b) => ({ id: Number(b.id), name: String(b.name ?? '') })),
  };
}
