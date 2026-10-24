/**
 * Lecture du regroupement pour les TIROIRS (lot 84B, CDC v5 O-3 : §7, §14 ;
 * AC27, AC28, §14.4). Lecture seule, bornée au compte actif dans chaque
 * requête (un identifiant d'un autre compte ne rend rien). Aucune écriture :
 * les gestes passent par le service unique de regroupement (`service.ts`).
 *
 * N'utilise PAS l'API Timeline (`overview`, chantier O-4) : ce module ne lit
 * que l'ensemble d'UN élément d'agenda ou d'UN document.
 */
import { db } from '@/db';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';
import type {
  AgendaGroupingView, GroupingCandidate, GroupingCandidateKind, GroupingCounts, GroupingDocumentRef, GroupingItemRef, GroupingNamedRef,
} from '@/lib/agenda/grouping-view';
import { drizzleRunner, type GroupingRunner } from './runner';

const CANDIDATE_LIMIT = 30;

interface ItemCtx { id: number; op: number | null; role: 'PRINCIPAL' | 'RELATED' | null }

async function itemContext(r: GroupingRunner, accountId: number, itemId: number): Promise<ItemCtx | null> {
  const [i] = await r.q<{ id: number; op: string | null; role: 'PRINCIPAL' | 'RELATED' | null; active: boolean | null }>(
    `SELECT i.id, i.business_operation_id AS op, i.operation_role AS role,
            (o.id IS NOT NULL AND o.account_id = i.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active
       FROM agenda_items i LEFT JOIN business_operations o ON o.id = i.business_operation_id
      WHERE i.id = $1 AND i.account_id = $2`, [itemId, accountId]);
  if (!i) return null;
  const op = i.op !== null && i.active ? Number(i.op) : null;
  return { id: Number(i.id), op, role: op === null ? null : i.role };
}

const titreDoc = (d: { retained_title: string | null; original_filename: string | null; filename: string | null; s3_key: string | null; public_id: string | null; id: number }) =>
  displayDocumentTitle({ retainedTitle: d.retained_title, originalFilename: d.original_filename, filename: d.filename, s3Key: d.s3_key, publicId: d.public_id }, `Document n° ${d.id}`);

async function ensembleItems(r: GroupingRunner, accountId: number, op: number, exceptId: number): Promise<GroupingItemRef[]> {
  const x = await r.q<{ id: number; title: string; d: string | null; role: string | null }>(
    `SELECT id, title, start_date::text AS d, operation_role AS role FROM agenda_items
      WHERE account_id = $1 AND business_operation_id = $2 AND id <> $3
      ORDER BY start_date NULLS LAST, id`, [accountId, op, exceptId]);
  return x.map((y) => ({ id: Number(y.id), title: y.title, startDate: y.d, isMain: y.role === 'PRINCIPAL' }));
}

/** Documents de l'ensemble (appartenance active) + liens directs de l'élément, avec la nature du lien de l'élément. */
async function ensembleDocuments(r: GroupingRunner, accountId: number, op: number, itemId: number): Promise<GroupingDocumentRef[]> {
  const x = await r.q<{ id: number; retained_title: string | null; original_filename: string | null; filename: string | null; s3_key: string | null; public_id: string | null; d: string | null; prov: string[] | null }>(
    `SELECT f.id, f.retained_title, f.original_filename, f.filename, f.s3_key, f.public_id::text AS public_id, f.document_date::text AS d,
            (SELECT l.provenances FROM agenda_file_links l WHERE l.agenda_item_id = $3 AND l.asset_file_id = f.id) AS prov
       FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL
        AND (EXISTS (SELECT 1 FROM business_operation_documents d WHERE d.operation_id = $2 AND d.account_id = $1 AND d.file_id = f.id AND d.active)
             OR EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = $3 AND l.asset_file_id = f.id))
      ORDER BY f.document_date DESC NULLS LAST, f.id`, [accountId, op, itemId]);
  return x.map((y) => {
    const prov = y.prov ?? null;
    const direct = !!prov && prov.some((p) => p === 'MANUAL_DIRECT' || p === 'AI_DIRECT');
    return { id: Number(y.id), title: titreDoc(y), documentDate: y.d, link: prov === null ? null : direct ? 'DIRECT' as const : 'GROUP' as const };
  });
}

/** Lot 86D : documents reliés à CET élément (agenda_file_links, documents du compte non supprimés), avec la nature du lien. */
async function itemDocuments(r: GroupingRunner, accountId: number, itemId: number): Promise<GroupingDocumentRef[]> {
  const x = await r.q<{ id: number; retained_title: string | null; original_filename: string | null; filename: string | null; s3_key: string | null; public_id: string | null; d: string | null; prov: string[] | null }>(
    `SELECT f.id, f.retained_title, f.original_filename, f.filename, f.s3_key, f.public_id::text AS public_id, f.document_date::text AS d, l.provenances AS prov
       FROM agenda_file_links l JOIN asset_files f ON f.id = l.asset_file_id AND f.account_id = $1 AND f.deleted_at IS NULL
      WHERE l.agenda_item_id = $2
      ORDER BY f.document_date DESC NULLS LAST, f.id`, [accountId, itemId]);
  return x.map((y) => {
    const prov = y.prov ?? [];
    const direct = prov.length === 0 || prov.some((p) => p === 'MANUAL_DIRECT' || p === 'AI_DIRECT');
    return { id: Number(y.id), title: titreDoc(y), documentDate: y.d, link: direct ? 'DIRECT' as const : 'GROUP' as const };
  });
}

async function ensembleTargets(r: GroupingRunner, accountId: number, op: number): Promise<{ assets: GroupingNamedRef[]; rooms: GroupingNamedRef[]; equipments: GroupingNamedRef[] }> {
  const assets = await r.q<{ id: number; name: string }>(
    `SELECT a.id, a.name FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
      WHERE l.operation_id = $2 AND l.active ORDER BY a.name, a.id`, [accountId, op]);
  const rooms = await r.q<{ id: number; name: string; asset_id: number }>(
    `SELECT s.id, s.name, s.asset_id FROM business_operation_room_links l
       JOIN substructures s ON s.id = l.substructure_id JOIN assets a ON a.id = s.asset_id AND a.account_id = $1
      WHERE l.operation_id = $2 AND l.account_id = $1 AND l.active ORDER BY s.name, s.id`, [accountId, op]);
  const equipments = await r.q<{ id: number; name: string; asset_id: number }>(
    `SELECT e.id, e.name, e.asset_id FROM business_operation_equipment_links l
       JOIN equipments e ON e.id = l.equipment_id JOIN assets a ON a.id = e.asset_id AND a.account_id = $1
      WHERE l.operation_id = $2 AND l.active ORDER BY e.name, e.id`, [accountId, op]);
  return {
    assets: assets.map((a) => ({ id: Number(a.id), name: a.name })),
    rooms: rooms.map((s) => ({ id: Number(s.id), name: s.name, assetId: Number(s.asset_id) })),
    equipments: equipments.map((e) => ({ id: Number(e.id), name: e.name, assetId: Number(e.asset_id) })),
  };
}

async function withdrawn(r: GroupingRunner, accountId: number, op: number): Promise<boolean> {
  const [x] = await r.q(`SELECT 1 FROM business_operation_match_decisions WHERE account_id = $1 AND candidate_operation_id = $2
                           AND source_kind = 'PRINCIPAL' AND decision = 'REJECTED' AND active LIMIT 1`, [accountId, op]);
  return !!x;
}

/**
 * Vue du regroupement d'un élément d'agenda pour son tiroir. `null` :
 * élément absent du compte.
 */
export async function getAgendaGroupingView(accountId: number, itemId: number, r: GroupingRunner = drizzleRunner(db)): Promise<AgendaGroupingView | null> {
  const it = await itemContext(r, accountId, itemId);
  if (!it) return null;
  const linkedDocuments = await itemDocuments(r, accountId, itemId);
  if (it.op === null) return { itemId, role: 'NONE', main: null, mainWithdrawn: false, ensemble: null, counts: null, linkedDocuments };
  const op = it.op;
  const items = await ensembleItems(r, accountId, op, itemId);
  const retire = await withdrawn(r, accountId, op);
  if (it.role === 'PRINCIPAL') {
    return {
      itemId, role: 'MAIN', main: null, mainWithdrawn: false,
      ensemble: { items, documents: await ensembleDocuments(r, accountId, op, itemId), ...(await ensembleTargets(r, accountId, op)) },
      counts: null, linkedDocuments,
    };
  }
  const principal = items.find((i) => i.isMain) ?? null;
  if (!principal) {
    // Ensemble sans événement de référence : les autres éléments sont le seul accès à l'ensemble.
    return { itemId, role: 'MEMBER', main: null, mainWithdrawn: retire, ensemble: { items, documents: [], assets: [], rooms: [], equipments: [] }, counts: null, linkedDocuments };
  }
  const [c] = await r.q<{ docs: number; assets: number; rooms: number; equips: number }>(
    `SELECT (SELECT count(*)::int FROM business_operation_documents d JOIN asset_files f ON f.id = d.file_id AND f.deleted_at IS NULL
              WHERE d.operation_id = $2 AND d.account_id = $1 AND d.active) AS docs,
            (SELECT count(*)::int FROM business_operation_asset_links l WHERE l.operation_id = $2 AND l.active) AS assets,
            (SELECT count(*)::int FROM business_operation_room_links l WHERE l.operation_id = $2 AND l.account_id = $1 AND l.active) AS rooms,
            (SELECT count(*)::int FROM business_operation_equipment_links l WHERE l.operation_id = $2 AND l.active) AS equips`, [accountId, op]);
  const counts: GroupingCounts = {
    // Événements de l'ensemble hors événement de référence (§13.7), cet élément compris.
    items: items.filter((i) => !i.isMain).length + 1, documents: Number(c?.docs ?? 0), assets: Number(c?.assets ?? 0), rooms: Number(c?.rooms ?? 0), equipments: Number(c?.equips ?? 0),
  };
  return { itemId, role: 'MEMBER', main: { id: principal.id, title: principal.title, startDate: principal.startDate }, mainWithdrawn: false, ensemble: null, counts, linkedDocuments };
}

/**
 * Candidats d'un geste « relier » depuis le tiroir d'un élément : objets du
 * compte pas encore reliés, ceux des mêmes biens d'abord ; filtre `q` sur le
 * nom (insensible à la casse). Bornés (30).
 */
export async function listGroupingCandidates(
  accountId: number, itemId: number, kind: GroupingCandidateKind, q: string, r: GroupingRunner = drizzleRunner(db),
): Promise<GroupingCandidate[] | null> {
  const it = await itemContext(r, accountId, itemId);
  if (!it) return null;
  const like = `%${q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const op = it.op ?? 0;
  // Biens de l'élément et de l'ensemble (priorité d'affichage seulement).
  const biens = `(SELECT asset_id FROM agenda_asset_links WHERE agenda_item_id = $2
                  UNION SELECT asset_id FROM business_operation_asset_links WHERE operation_id = $3 AND active)`;
  switch (kind) {
    case 'elements': {
      const x = await r.q<{ id: number; title: string; d: string | null }>(
        `SELECT i.id, i.title, i.start_date::text AS d FROM agenda_items i
          WHERE i.account_id = $1 AND i.id <> $2 AND i.business_operation_id IS DISTINCT FROM $3::bigint
            AND i.title ILIKE $4
          ORDER BY EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id IN ${biens}) DESC,
                   i.start_date DESC NULLS LAST, i.id DESC
          LIMIT ${CANDIDATE_LIMIT}`, [accountId, itemId, op, like]);
      return x.map((y) => ({ id: Number(y.id), title: y.title, meta: y.d }));
    }
    case 'documents': {
      const x = await r.q<{ id: number; retained_title: string | null; original_filename: string | null; filename: string | null; s3_key: string | null; public_id: string | null; d: string | null }>(
        `SELECT f.id, f.retained_title, f.original_filename, f.filename, f.s3_key, f.public_id::text AS public_id, f.document_date::text AS d
           FROM asset_files f
          WHERE f.account_id = $1 AND f.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = $2 AND l.asset_file_id = f.id)
            AND NOT EXISTS (SELECT 1 FROM business_operation_documents d WHERE d.operation_id = $3 AND d.file_id = f.id AND d.active)
            AND (COALESCE(f.retained_title, '') ILIKE $4 OR COALESCE(f.original_filename, '') ILIKE $4 OR COALESCE(f.filename, '') ILIKE $4)
          ORDER BY (f.asset_id IN ${biens}) DESC NULLS LAST, f.document_date DESC NULLS LAST, f.id DESC
          LIMIT ${CANDIDATE_LIMIT}`, [accountId, itemId, op, like]);
      return x.map((y) => ({ id: Number(y.id), title: titreDoc(y), meta: y.d }));
    }
    case 'biens': {
      const x = await r.q<{ id: number; name: string }>(
        `SELECT a.id, a.name FROM assets a
          WHERE a.account_id = $1 AND a.deleted_at IS NULL AND a.name ILIKE $4
            AND NOT EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = $3 AND l.asset_id = a.id AND l.active)
          ORDER BY (a.id IN ${biens}) DESC, a.name, a.id LIMIT ${CANDIDATE_LIMIT}`, [accountId, itemId, op, like]);
      return x.map((y) => ({ id: Number(y.id), title: y.name, meta: null }));
    }
    case 'pieces': {
      const x = await r.q<{ id: number; name: string; asset: string }>(
        `SELECT s.id, s.name, a.name AS asset FROM substructures s JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
          WHERE s.name ILIKE $4
            AND NOT EXISTS (SELECT 1 FROM business_operation_room_links l WHERE l.operation_id = $3 AND l.substructure_id = s.id AND l.active)
          ORDER BY (s.asset_id IN ${biens}) DESC, a.name, s.name, s.id LIMIT ${CANDIDATE_LIMIT}`, [accountId, itemId, op, like]);
      return x.map((y) => ({ id: Number(y.id), title: y.name, meta: y.asset }));
    }
    case 'equipements': {
      const x = await r.q<{ id: number; name: string; asset: string }>(
        `SELECT e.id, e.name, a.name AS asset FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
          WHERE e.name ILIKE $4
            AND NOT EXISTS (SELECT 1 FROM business_operation_equipment_links l WHERE l.operation_id = $3 AND l.equipment_id = e.id AND l.active)
          ORDER BY (e.asset_id IN ${biens}) DESC, a.name, e.name, e.id LIMIT ${CANDIDATE_LIMIT}`, [accountId, itemId, op, like]);
      return x.map((y) => ({ id: Number(y.id), title: y.name, meta: y.asset }));
    }
  }
}

export interface DocumentAgendaLinkView {
  itemId: number;
  /** Lien précis (saisi ou IA) — §7.3. */
  direct: boolean;
  /** Lien par l'ensemble (propagé vers l'événement de référence, §7.1). */
  viaGroup: boolean;
  /** L'élément est l'événement de référence de son ensemble. */
  isMain: boolean;
}

/** Nature des liens d'un document vers les éléments d'agenda (DocumentDrawer, §14.4). `null` : document absent du compte. */
export async function getDocumentAgendaLinks(accountId: number, fileId: number, r: GroupingRunner = drizzleRunner(db)): Promise<DocumentAgendaLinkView[] | null> {
  const [f] = await r.q(`SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, accountId]);
  if (!f) return null;
  const x = await r.q<{ id: number; prov: string[] | null; role: string | null }>(
    `SELECT i.id, l.provenances AS prov, i.operation_role AS role FROM agenda_file_links l
       JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $2
      WHERE l.asset_file_id = $1 ORDER BY i.start_date NULLS LAST, i.id`, [fileId, accountId]);
  return x.map((y) => {
    const prov = y.prov ?? [];
    return {
      itemId: Number(y.id),
      direct: prov.includes('MANUAL_DIRECT') || prov.includes('AI_DIRECT') || prov.length === 0,
      viaGroup: prov.includes('OPERATION_PRINCIPAL'),
      isMain: y.role === 'PRINCIPAL',
    };
  });
}

/**
 * Éléments d'agenda du compte qu'un document peut rejoindre (lien manuel,
 * AC01) : pas encore liés au document, ceux du même bien d'abord ; filtre `q`.
 * `null` : document absent du compte.
 */
export async function listAgendaCandidatesForDocument(accountId: number, fileId: number, q: string, r: GroupingRunner = drizzleRunner(db)): Promise<GroupingCandidate[] | null> {
  const [f] = await r.q<{ asset_id: number | null }>(`SELECT asset_id FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, accountId]);
  if (!f) return null;
  const like = `%${q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const x = await r.q<{ id: number; title: string; d: string | null }>(
    `SELECT i.id, i.title, i.start_date::text AS d FROM agenda_items i
      WHERE i.account_id = $1 AND i.title ILIKE $3
        AND NOT EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND l.asset_file_id = $2)
      ORDER BY EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = $4::int) DESC,
               i.start_date DESC NULLS LAST, i.id DESC
      LIMIT ${CANDIDATE_LIMIT}`, [accountId, fileId, like, f.asset_id ?? 0]);
  return x.map((y) => ({ id: Number(y.id), title: y.title, meta: y.d }));
}
