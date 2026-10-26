/**
 * Pièce ↔ équipements ↔ documents ↔ échéances — RÉSOLUTION CENTRALE.
 * Lot 75 (75B), ticket « Pièces — gestion bidirectionnelle ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE RÈGLE, TROIS ÉCRANS
 *
 * Le tiroir Pièce, le filtre Pièce de « Mes documents » et celui de « Mon
 * agenda » lisent TOUS la sous-requête `roomDocumentLinksSql` et la lecture
 * `agendaItemIdsByRoom` ci-dessous — jamais une copie de la règle.
 *
 * Pièce = sous-structure (`substructures`, décision D-G). Associations
 * PERSISTÉES existantes, aucune nouvelle table, aucun lien « artificiel » :
 *
 *   · équipement → pièce  : `equipments.substructure_id` (une pièce au plus,
 *     cardinalité du modèle conservée) ;
 *   · document → pièce, DIRECT : colonne `asset_files.substructure_id`, OU
 *     lien N-N ACTIF `document_asset_links.substructure_id` de rôle PRIMARY /
 *     SECONDARY SANS équipement (un lien qui porte un équipement est un lien
 *     d'ÉQUIPEMENT : sa pièce est celle de l'équipement, lue à l'instant) ;
 *   · document → pièce, INDIRECT (« Via [équipement] ») : document associé
 *     (colonne `asset_files.equipment_id` ou lien N-N PRIMARY / SECONDARY,
 *     même règle que le filtre Équipement du lot 71) à un équipement dont la
 *     pièce ACTUELLE est celle-ci, pièce et équipement du MÊME bien ;
 *   · échéance → pièce : `agenda_room_links` (direct), `agenda_equipment_links`
 *     vers un équipement de la pièce, et liens échéance ↔ document
 *     (`agenda_file_links`, traces `agenda_item_sources` liées, élément
 *     automatique issu du document) vers un document de la pièce (direct ou
 *     indirect).
 *
 * L'indirect est CALCULÉ à chaque lecture, jamais recopié : déplacer le
 * réfrigérateur de Cuisine vers Cellier fait suivre ses documents et ses
 * échéances sans écrire une seule ligne de lien. Un élément trouvé par
 * plusieurs chemins n'est compté qu'une fois (UNION / ensembles).
 *
 * Droits : toute lecture est bornée au compte (bien du compte, non
 * supprimé) ; une pièce, un équipement ou un document d'un autre compte ou
 * d'un autre bien n'est jamais lu ni écrit.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { ASSET_LIST_LINK_ROLES_SQL } from '@/services/documents/asset-document-scope';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';
import { getDocumentType } from '@/lib/referential/v2';
import { ROOM_FILTER_MAX_OPTIONS } from '@/lib/filters/room-filter';
import type { RoomDocumentEntry, RoomEquipmentEntry, RoomCandidate } from '@/lib/rooms/room-associations';

/** Identifiants positifs, uniques. */
export function cleanRoomIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

const roles = sql.raw(ASSET_LIST_LINK_ROLES_SQL);

/**
 * Sous-requête `(file_id, room_id, via_equipment_id)` : tous les chemins
 * document → pièce. `via_equipment_id` NULL = association DIRECTE.
 * Indexée (0542_idx_1..4). Le document n'est PAS borné ici : l'appelant
 * applique son périmètre (compte, non supprimé).
 */
export function roomDocumentLinksSql(roomIds: readonly number[]): SQL {
  const ids = cleanRoomIds(roomIds);
  if (ids.length === 0) {
    return sql`(SELECT NULL::int AS file_id, NULL::int AS room_id, NULL::int AS via_equipment_id WHERE FALSE)`;
  }
  const liste = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  return sql`(
    SELECT f.id AS file_id, f.substructure_id AS room_id, NULL::int AS via_equipment_id
      FROM asset_files f WHERE f.substructure_id IN (${liste})
    UNION
    SELECT dal.file_id, dal.substructure_id, NULL::int
      FROM document_asset_links dal
     WHERE dal.substructure_id IN (${liste}) AND dal.equipment_id IS NULL
       AND dal.status = 'ACTIVE' AND dal.link_role IN ${roles}
    UNION
    SELECT f.id, e.substructure_id, e.id
      FROM equipments e
      JOIN substructures s ON s.id = e.substructure_id AND s.asset_id = e.asset_id
      JOIN asset_files f ON f.equipment_id = e.id
     WHERE e.substructure_id IN (${liste})
    UNION
    SELECT dal.file_id, e.substructure_id, e.id
      FROM equipments e
      JOIN substructures s ON s.id = e.substructure_id AND s.asset_id = e.asset_id
      JOIN document_asset_links dal ON dal.equipment_id = e.id
     WHERE e.substructure_id IN (${liste})
       AND dal.status = 'ACTIVE' AND dal.link_role IN ${roles}
  )`;
}

/** Condition Drizzle (table `asset_files` non aliasée) : document de l'une de ces pièces (direct OU indirect). */
function documentOfRoomsCondition(roomIds: readonly number[]): SQL {
  if (cleanRoomIds(roomIds).length === 0) return sql`FALSE`;
  return sql`${assetFiles.id} IN (SELECT rl.file_id FROM ${roomDocumentLinksSql(roomIds)} rl)`;
}

export interface AssetRoom {
  id: number;
  name: string;
  assetId: number;
  assetName: string;
}

/** Pièces des biens (du compte, non supprimés), dans l'ordre de la fiche. Une requête bornée. */
export async function listRoomsOfAssets(accountId: number, assetIds: readonly number[]): Promise<AssetRoom[]> {
  const ids = cleanRoomIds(assetIds).slice(0, 100);
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT s.id, s.name, s.asset_id AS "assetId", a.name AS "assetName"
      FROM substructures s
      JOIN assets a ON a.id = s.asset_id AND a.account_id = ${accountId} AND a.deleted_at IS NULL
     WHERE s.asset_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
     ORDER BY a.name, s.asset_id, s.order_index, s.id
     LIMIT ${ROOM_FILTER_MAX_OPTIONS}`)) as unknown as Array<{ id: number; name: string; assetId: number; assetName: string | null }>;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, assetId: Number(r.assetId), assetName: r.assetName ?? '' }));
}

/**
 * Condition du filtre Pièce sur les documents, ou `null` (aucun effet).
 * Pièce absente des biens retenus (lien abîmé, autre compte) : `FALSE`.
 */
export function documentRoomFilterCondition(roomId: number | null, assetRooms: readonly Pick<AssetRoom, 'id'>[]): SQL | null {
  if (roomId === null || assetRooms.length === 0) return null;
  return assetRooms.some((r) => r.id === roomId) ? documentOfRoomsCondition([roomId]) : sql`FALSE`;
}

// ── Pièce du compte ──────────────────────────────────────────────────────

export interface RoomRef {
  id: number;
  name: string;
  assetId: number;
  assetName: string;
}

/** La pièce, si son bien appartient au compte et n'est pas supprimé. */
export async function getRoomInAccount(accountId: number, roomId: number): Promise<RoomRef | null> {
  if (!Number.isSafeInteger(roomId) || roomId <= 0) return null;
  const [r] = (await db.execute(sql`
    SELECT s.id, s.name, s.asset_id AS "assetId", a.name AS "assetName"
      FROM substructures s
      JOIN assets a ON a.id = s.asset_id AND a.account_id = ${accountId} AND a.deleted_at IS NULL
     WHERE s.id = ${roomId} LIMIT 1`)) as unknown as Array<{ id: number; name: string; assetId: number; assetName: string | null }>;
  return r ? { id: Number(r.id), name: r.name, assetId: Number(r.assetId), assetName: r.assetName ?? '' } : null;
}

// ── Lectures du tiroir Pièce ─────────────────────────────────────────────

/** Équipements de la pièce (même bien), triés par nom. */
export async function listRoomEquipments(room: RoomRef): Promise<RoomEquipmentEntry[]> {
  const rows = (await db.execute(sql`
    SELECT e.id, e.name, e.type, e.status, e.archived_at IS NOT NULL AS archived
      FROM equipments e
     WHERE e.substructure_id = ${room.id} AND e.asset_id = ${room.assetId}
     ORDER BY lower(e.name), e.id`)) as unknown as Array<{ id: number; name: string; type: string | null; status: string; archived: boolean }>;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, type: r.type ?? null, status: r.status, archived: !!r.archived }));
}

/**
 * Documents de la pièce, liste CONSOLIDÉE : chaque document une seule fois,
 * avec sa provenance (`direct` et/ou équipements d'origine). Bornée au compte,
 * documents non supprimés et téléversés.
 */
export async function listRoomDocuments(accountId: number, room: RoomRef): Promise<RoomDocumentEntry[]> {
  const rows = (await db.execute(sql`
    SELECT f.id, f.public_id AS "publicId", f.retained_title AS "retainedTitle", f.original_filename AS "originalFilename",
           f.filename, f.web_link_title AS "webLinkTitle", f.document_type_code AS "documentTypeCode",
           f.document_date::text AS "documentDate", f.mime_type AS "mimeType",
           bool_or(rl.via_equipment_id IS NULL) AS direct,
           COALESCE(json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY lower(e.name), e.id)
                    FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS via
      FROM ${roomDocumentLinksSql([room.id])} rl
      JOIN asset_files f ON f.id = rl.file_id
      LEFT JOIN equipments e ON e.id = rl.via_equipment_id
     WHERE f.account_id = ${accountId} AND f.deleted_at IS NULL
       AND (f.upload_status = 'COMPLETED' OR f.upload_status IS NULL)
     GROUP BY f.id
     ORDER BY f.document_date DESC NULLS LAST, f.id DESC
     LIMIT 500`)) as unknown as Array<{
      id: number; publicId: string; retainedTitle: string | null; originalFilename: string | null; filename: string | null;
      webLinkTitle: string | null; documentTypeCode: string | null; documentDate: string | null; mimeType: string | null;
      direct: boolean; via: Array<{ id: number; name: string }> | string;
    }>;
  return rows.map((r) => {
    const via = (typeof r.via === 'string' ? JSON.parse(r.via) : r.via) as Array<{ id: number; name: string }>;
    // Un même équipement peut porter le document par deux chemins (colonne et lien) : une fois.
    const seen = new Set<number>();
    return {
      id: Number(r.id),
      publicId: r.publicId,
      title: displayDocumentTitle({ retainedTitle: r.retainedTitle, originalFilename: r.originalFilename, filename: r.filename, webLinkTitle: r.webLinkTitle, publicId: r.publicId }, 'Document'),
      documentTypeLabel: getDocumentType(r.documentTypeCode)?.label ?? null,
      documentDate: r.documentDate ?? null,
      mimeType: r.mimeType ?? null,
      direct: !!r.direct,
      via: via.filter((v) => (seen.has(Number(v.id)) ? false : (seen.add(Number(v.id)), true))).map((v) => ({ id: Number(v.id), name: v.name })),
    };
  });
}

/**
 * Candidats à l'association depuis la pièce : équipements ou documents du
 * MÊME bien. Un équipement porte sa pièce actuelle (réaffectation à
 * confirmer) ; un document directement associé à la pièce n'est pas proposé.
 * Documents : seulement ceux dont le bien PRINCIPAL est celui de la pièce
 * (la colonne `substructure_id` doit rester cohérente avec `asset_id`).
 */
export async function listRoomCandidates(
  accountId: number,
  room: RoomRef,
  kind: 'equipment' | 'document',
  q: string,
): Promise<RoomCandidate[]> {
  const motif = q.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  if (kind === 'equipment') {
    const rows = (await db.execute(sql`
      SELECT e.id, e.name, e.type, e.substructure_id AS "roomId", s.name AS "roomName"
        FROM equipments e
        JOIN assets a ON a.id = e.asset_id AND a.account_id = ${accountId} AND a.deleted_at IS NULL
        LEFT JOIN substructures s ON s.id = e.substructure_id
       WHERE e.asset_id = ${room.assetId} AND e.substructure_id IS DISTINCT FROM ${room.id}
         AND e.archived_at IS NULL
         ${motif ? sql`AND e.name ILIKE ${motif}` : sql``}
       ORDER BY lower(e.name), e.id
       LIMIT 100`)) as unknown as Array<{ id: number; name: string; type: string | null; roomId: number | null; roomName: string | null }>;
    return rows.map((r) => ({
      id: Number(r.id), title: r.name, meta: r.type ?? null,
      currentRoom: r.roomId ? { id: Number(r.roomId), name: r.roomName ?? '' } : null,
    }));
  }
  const rows = (await db.execute(sql`
    SELECT f.id, f.public_id AS "publicId", f.retained_title AS "retainedTitle", f.original_filename AS "originalFilename",
           f.filename, f.web_link_title AS "webLinkTitle", f.document_date::text AS "documentDate",
           f.substructure_id AS "roomId", s.name AS "roomName"
      FROM asset_files f
      LEFT JOIN substructures s ON s.id = f.substructure_id
     WHERE f.account_id = ${accountId} AND f.deleted_at IS NULL
       AND (f.upload_status = 'COMPLETED' OR f.upload_status IS NULL)
       AND f.asset_id = ${room.assetId}
       AND f.substructure_id IS DISTINCT FROM ${room.id}
       AND f.id NOT IN (SELECT rl.file_id FROM ${roomDocumentLinksSql([room.id])} rl WHERE rl.via_equipment_id IS NULL)
       ${motif ? sql`AND COALESCE(f.retained_title, f.web_link_title, f.original_filename, f.filename, '') ILIKE ${motif}` : sql``}
     ORDER BY f.uploaded_at DESC NULLS LAST, f.id DESC
     LIMIT 100`)) as unknown as Array<{
      id: number; publicId: string; retainedTitle: string | null; originalFilename: string | null; filename: string | null;
      webLinkTitle: string | null; documentDate: string | null; roomId: number | null; roomName: string | null;
    }>;
  return rows.map((r) => ({
    id: Number(r.id),
    title: displayDocumentTitle({ retainedTitle: r.retainedTitle, originalFilename: r.originalFilename, filename: r.filename, webLinkTitle: r.webLinkTitle, publicId: r.publicId }, 'Document'),
    meta: r.documentDate ?? null,
    currentRoom: r.roomId ? { id: Number(r.roomId), name: r.roomName ?? '' } : null,
  }));
}

// ── Agenda ───────────────────────────────────────────────────────────────

/**
 * Échéances de chaque pièce (directes, via ses équipements, via ses
 * documents directs ou indirects), bornées au compte. Une requête ; un
 * élément atteint par plusieurs chemins n'est compté qu'une fois par pièce.
 */
export async function agendaItemIdsByRoom(accountId: number, roomIds: readonly number[]): Promise<Map<number, Set<number>>> {
  const ids = cleanRoomIds(roomIds);
  const out = new Map<number, Set<number>>(ids.map((id) => [id, new Set<number>()]));
  if (ids.length === 0) return out;
  const liste = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const rows = (await db.execute(sql`
    WITH docs AS (
      SELECT DISTINCT rl.file_id, rl.room_id FROM ${roomDocumentLinksSql(ids)} rl
        JOIN asset_files f ON f.id = rl.file_id AND f.account_id = ${accountId} AND f.deleted_at IS NULL
    ), pairs AS (
      SELECT arl.agenda_item_id AS item_id, arl.substructure_id AS room_id
        FROM agenda_room_links arl WHERE arl.substructure_id IN (${liste})
      UNION
      SELECT ael.agenda_item_id, e.substructure_id
        FROM equipments e
        JOIN substructures s ON s.id = e.substructure_id AND s.asset_id = e.asset_id
        JOIN agenda_equipment_links ael ON ael.equipment_id = e.id
       WHERE e.substructure_id IN (${liste})
      UNION
      SELECT afl.agenda_item_id, d.room_id FROM docs d JOIN agenda_file_links afl ON afl.asset_file_id = d.file_id
      UNION
      SELECT ais.agenda_item_id, d.room_id FROM docs d JOIN agenda_item_sources ais ON ais.asset_file_id = d.file_id
       WHERE ais.agenda_item_id IS NOT NULL AND ais.effect_type IN ('created', 'resolved_existing', 'linked')
      UNION
      SELECT ai.id, d.room_id FROM docs d JOIN agenda_items ai
          ON ai.account_id = ${accountId} AND ai.origin_ref_type = 'asset_file' AND ai.origin_ref_id = d.file_id
    )
    SELECT p.item_id AS "itemId", p.room_id AS "roomId"
      FROM pairs p JOIN agenda_items i ON i.id = p.item_id AND i.account_id = ${accountId}`)) as unknown as Array<{ itemId: number; roomId: number }>;
  for (const r of rows) out.get(Number(r.roomId))?.add(Number(r.itemId));
  return out;
}

// ── Écritures (tiroir Pièce) ─────────────────────────────────────────────

export class RoomAssociationError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'OTHER_ASSET' | 'NOT_DIRECT', message: string) {
    super(message);
    this.name = 'RoomAssociationError';
  }
}

interface ReassignConflict {
  id: number;
  title: string;
  currentRoom: { id: number; name: string };
}

type AssociateOutcome =
  | { status: 'done'; associated: number[] }
  | { status: 'confirm'; conflicts: ReassignConflict[] };

/**
 * Associe des équipements EXISTANTS du même bien à la pièce. Cardinalité du
 * modèle : un équipement a une pièce au plus — un équipement déjà dans une
 * AUTRE pièce n'est déplacé qu'après confirmation (`confirmReassign`) ;
 * sinon rien n'est écrit et les conflits sont rendus. Tout ou rien.
 */
export async function associateEquipmentsToRoom(
  accountId: number,
  room: RoomRef,
  equipmentIds: readonly number[],
  confirmReassign: boolean,
): Promise<AssociateOutcome> {
  const ids = cleanRoomIds(equipmentIds).slice(0, 100);
  if (ids.length === 0) return { status: 'done', associated: [] };
  const liste = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT e.id, e.name, e.asset_id AS "assetId", e.substructure_id AS "roomId", s.name AS "roomName"
      FROM equipments e
      JOIN assets a ON a.id = e.asset_id AND a.account_id = ${accountId} AND a.deleted_at IS NULL
      LEFT JOIN substructures s ON s.id = e.substructure_id
     WHERE e.id IN (${liste})`)) as unknown as Array<{ id: number; name: string; assetId: number; roomId: number | null; roomName: string | null }>;
  if (rows.length !== ids.length) throw new RoomAssociationError('NOT_FOUND', 'Équipement introuvable');
  if (rows.some((r) => Number(r.assetId) !== room.assetId)) {
    throw new RoomAssociationError('OTHER_ASSET', 'Un équipement appartient à un autre bien que la pièce');
  }
  const conflicts = rows
    .filter((r) => r.roomId !== null && Number(r.roomId) !== room.id)
    .map((r) => ({ id: Number(r.id), title: r.name, currentRoom: { id: Number(r.roomId), name: r.roomName ?? '' } }));
  if (conflicts.length > 0 && !confirmReassign) return { status: 'confirm', conflicts };
  // Bien re-vérifié dans l'écriture (déplacement concurrent vers un autre bien).
  await db.execute(sql`
    UPDATE equipments SET substructure_id = ${room.id}, updated_at = now()
     WHERE id IN (${liste}) AND asset_id = ${room.assetId} AND substructure_id IS DISTINCT FROM ${room.id}`);
  return { status: 'done', associated: ids };
}

/** Dissocie l'équipement de la pièce (pièce → aucune). Jamais de suppression. */
export async function dissociateEquipmentFromRoom(accountId: number, room: RoomRef, equipmentId: number): Promise<void> {
  const [r] = (await db.execute(sql`
    SELECT e.substructure_id AS "roomId" FROM equipments e
      JOIN assets a ON a.id = e.asset_id AND a.account_id = ${accountId} AND a.deleted_at IS NULL
     WHERE e.id = ${equipmentId} AND e.asset_id = ${room.assetId} LIMIT 1`)) as unknown as Array<{ roomId: number | null }>;
  if (!r) throw new RoomAssociationError('NOT_FOUND', 'Équipement introuvable');
  if (r.roomId === null || Number(r.roomId) !== room.id) throw new RoomAssociationError('NOT_DIRECT', 'Équipement absent de cette pièce');
  await db.execute(sql`
    UPDATE equipments SET substructure_id = NULL, updated_at = now()
     WHERE id = ${equipmentId} AND substructure_id = ${room.id}`);
}

/**
 * Associe des documents EXISTANTS du même bien à la pièce : colonne
 * `asset_files.substructure_id` — celle que lit et écrit le tiroir Document
 * (le déclencheur 0221/0229 la reflète en lien LEGACY_COLUMN). Un document a
 * une pièce au plus dans cette colonne : déjà dans une AUTRE pièce, il n'est
 * déplacé qu'après confirmation. Ses équipements et autres liens ne changent pas.
 */
export async function associateDocumentsToRoom(
  accountId: number,
  room: RoomRef,
  fileIds: readonly number[],
  confirmReassign: boolean,
): Promise<AssociateOutcome> {
  const ids = cleanRoomIds(fileIds).slice(0, 100);
  if (ids.length === 0) return { status: 'done', associated: [] };
  const liste = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT f.id, f.asset_id AS "assetId", f.substructure_id AS "roomId", s.name AS "roomName",
           f.public_id AS "publicId", f.retained_title AS "retainedTitle", f.original_filename AS "originalFilename",
           f.filename, f.web_link_title AS "webLinkTitle"
      FROM asset_files f
      LEFT JOIN substructures s ON s.id = f.substructure_id
     WHERE f.id IN (${liste}) AND f.account_id = ${accountId} AND f.deleted_at IS NULL`)) as unknown as Array<{
      id: number; assetId: number | null; roomId: number | null; roomName: string | null;
      publicId: string; retainedTitle: string | null; originalFilename: string | null; filename: string | null; webLinkTitle: string | null;
    }>;
  if (rows.length !== ids.length) throw new RoomAssociationError('NOT_FOUND', 'Document introuvable');
  if (rows.some((r) => r.assetId === null || Number(r.assetId) !== room.assetId)) {
    throw new RoomAssociationError('OTHER_ASSET', 'Un document n’est pas rattaché au bien de la pièce');
  }
  const conflicts = rows
    .filter((r) => r.roomId !== null && Number(r.roomId) !== room.id)
    .map((r) => ({
      id: Number(r.id),
      title: displayDocumentTitle({ retainedTitle: r.retainedTitle, originalFilename: r.originalFilename, filename: r.filename, webLinkTitle: r.webLinkTitle, publicId: r.publicId }, 'Document'),
      currentRoom: { id: Number(r.roomId), name: r.roomName ?? '' },
    }));
  if (conflicts.length > 0 && !confirmReassign) return { status: 'confirm', conflicts };
  await db.execute(sql`
    UPDATE asset_files SET substructure_id = ${room.id}, updated_at = now()
     WHERE id IN (${liste}) AND account_id = ${accountId} AND asset_id = ${room.assetId}
       AND deleted_at IS NULL AND substructure_id IS DISTINCT FROM ${room.id}`);
  return { status: 'done', associated: ids };
}

/**
 * Retire l'association DIRECTE document ↔ pièce : colonne remise à NULL si
 * elle désigne la pièce, liens N-N directs (hors LEGACY_COLUMN, tenus par la
 * colonne) passés en REMOVED. Le document, ses équipements et ses autres
 * liens restent intacts. Un document seulement « Via [équipement] » n'a pas
 * d'association directe : refus `NOT_DIRECT` (on dissocie l'équipement).
 */
export async function dissociateDocumentFromRoom(accountId: number, room: RoomRef, fileId: number): Promise<void> {
  const [f] = (await db.execute(sql`
    SELECT f.substructure_id AS "roomId",
           EXISTS (SELECT 1 FROM document_asset_links dal
                    WHERE dal.file_id = f.id AND dal.substructure_id = ${room.id} AND dal.equipment_id IS NULL
                      AND dal.status = 'ACTIVE' AND dal.origin <> 'LEGACY_COLUMN') AS "hasLink"
      FROM asset_files f
     WHERE f.id = ${fileId} AND f.account_id = ${accountId} AND f.deleted_at IS NULL LIMIT 1`)) as unknown as Array<{ roomId: number | null; hasLink: boolean }>;
  if (!f) throw new RoomAssociationError('NOT_FOUND', 'Document introuvable');
  const parColonne = f.roomId !== null && Number(f.roomId) === room.id;
  if (!parColonne && !f.hasLink) throw new RoomAssociationError('NOT_DIRECT', 'Document sans association directe avec cette pièce');
  if (parColonne) {
    await db.execute(sql`
      UPDATE asset_files SET substructure_id = NULL, updated_at = now()
       WHERE id = ${fileId} AND account_id = ${accountId} AND substructure_id = ${room.id}`);
  }
  if (f.hasLink) {
    await db.execute(sql`
      UPDATE document_asset_links SET status = 'REMOVED', removed_at = now(), updated_at = now()
       WHERE file_id = ${fileId} AND account_id = ${accountId} AND substructure_id = ${room.id} AND equipment_id IS NULL
         AND status = 'ACTIVE' AND origin <> 'LEGACY_COLUMN'`);
  }
}
