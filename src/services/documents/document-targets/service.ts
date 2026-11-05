/**
 * Lot 111I — rattachement MULTIPLE d'un document : lecture et écriture
 * serveur (règles pures dans `./plan`).
 *
 *   · `readDocumentTargets`   sélection actuelle (colonnes + liens ACTIFS),
 *                              provenance par cible, implications, bornée au compte ;
 *   · `listTargetOptions`      biens du compte, leurs pièces et équipements
 *                              (sélecteurs groupés par bien) ;
 *   · `applyDocumentTargets`   écriture DANS la transaction de l'appelant :
 *                              colonnes « principal » (déclencheur 0221 →
 *                              liens LEGACY_COLUMN), liens USER des autres
 *                              cibles, retraits = DISSOCIATION (status
 *                              REMOVED + trace de refus USER/REJECTED, lue
 *                              par le rapprochement automatique comme une
 *                              exclusion) — jamais de suppression de document
 *                              ni de DELETE de lien.
 *
 * Décision utilisateur prioritaire : en mode `replace` (tiroir), chaque
 * niveau modifié est marqué dans `user_edited_fields` (`assetId`,
 * `substructureId`, `equipmentId`) : T3 DOCUMENT_ASSET et le rapprochement
 * document ↔ équipement (`USER_PROTECTED`) ne le défont plus. Mode `add`
 * (dépôt : cibles complémentaires) : liens ajoutés, rien retiré, aucune marque.
 *
 * Isolation : document, biens, pièces, équipements lus DANS le compte ;
 * une cible inconnue ou étrangère lève `TargetSelectionError('NOT_FOUND')`
 * (réponse 404 sans détail, journal `security.cross_account_refused`). Un
 * bien verrouillé (déplacement / suppression Duo en cours) ou archivé ne
 * reçoit aucun NOUVEAU lien (`ASSET_LOCKED`) ; ses liens existants restent.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  currentSelection, diffLinks, levelChanged, linkKey, principalColumns, provenanceOf, resolveSelection, assertSelectionKnown,
  isAttaching, TargetSelectionError,
  type ActiveTargetLink, type TargetCatalog, type TargetColumns, type TargetSelection, type TargetProvenance,
} from './plan';

/** Exécutant SQL : `db` ou une transaction Drizzle. */
export interface TargetsExecutor { execute: (q: SQL) => Promise<unknown> }

type Row = Record<string, unknown>;
const q = async <T = Row>(x: TargetsExecutor, s: SQL): Promise<T[]> => (await x.execute(s)) as unknown as T[];
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const intArray = (ids: readonly number[]) => sql`${`{${ids.filter((i) => Number.isSafeInteger(i) && i > 0).join(',')}}`}::int[]`;

interface FileState {
  columns: TargetColumns;
  userEdited: Record<string, boolean>;
  active: ActiveTargetLink[];
}

async function readFileState(x: TargetsExecutor, accountId: number, fileId: number, lock = false): Promise<FileState | null> {
  const [f] = await q(x, sql`
    SELECT f.asset_id, f.linked_asset_id, f.substructure_id, f.equipment_id, f.linked_room_id, f.user_edited_fields,
           (SELECT r.asset_id FROM rooms r WHERE r.id = f.linked_room_id) AS linked_room_asset_id
      FROM asset_files f
     WHERE f.id = ${fileId} AND f.account_id = ${accountId} AND f.deleted_at IS NULL
     ${lock ? sql`FOR UPDATE OF f` : sql``}`);
  if (!f) return null;
  return {
    columns: {
      assetId: n(f.asset_id), linkedAssetId: n(f.linked_asset_id), substructureId: n(f.substructure_id),
      equipmentId: n(f.equipment_id), linkedRoomId: n(f.linked_room_id), linkedRoomAssetId: n(f.linked_room_asset_id),
    },
    userEdited: (typeof f.user_edited_fields === 'string' ? JSON.parse(f.user_edited_fields) : f.user_edited_fields ?? {}) as Record<string, boolean>,
    active: await readActiveLinks(x, accountId, fileId),
  };
}

async function readActiveLinks(x: TargetsExecutor, accountId: number, fileId: number): Promise<ActiveTargetLink[]> {
  return (await q(x, sql`
    SELECT id, asset_id, room_id, substructure_id, equipment_id, link_role, origin
      FROM document_asset_links
     WHERE file_id = ${fileId} AND account_id = ${accountId} AND status = 'ACTIVE'
     ORDER BY id`)).map((l) => ({
    id: Number(l.id), assetId: n(l.asset_id), roomId: n(l.room_id), substructureId: n(l.substructure_id),
    equipmentId: n(l.equipment_id), linkRole: String(l.link_role), origin: String(l.origin),
  }));
}

/**
 * Catalogue des cibles DU COMPTE nécessaires (identifiants demandés et
 * actuels). Biens non supprimés ; `writable` : ni archivé, ni verrouillé.
 */
async function readCatalog(x: TargetsExecutor, accountId: number, ids: { assets: number[]; rooms: number[]; equipments: number[] }): Promise<TargetCatalog> {
  const eq = ids.equipments.length ? await q(x, sql`
    SELECT e.id, e.name, e.asset_id, e.substructure_id,
           (s.id IS NOT NULL) AS room_ok
      FROM equipments e
      JOIN assets a ON a.id = e.asset_id AND a.account_id = ${accountId} AND a.deleted_at IS NULL
      LEFT JOIN substructures s ON s.id = e.substructure_id AND s.asset_id = e.asset_id
     WHERE e.id = ANY(${intArray(ids.equipments)})`) : [];
  const roomIds = [...new Set([...ids.rooms, ...eq.map((e) => n(e.substructure_id)).filter((v): v is number => v !== null)])];
  const rooms = roomIds.length ? await q(x, sql`
    SELECT s.id, s.name, s.asset_id FROM substructures s
      JOIN assets a ON a.id = s.asset_id AND a.account_id = ${accountId} AND a.deleted_at IS NULL
     WHERE s.id = ANY(${intArray(roomIds)})`) : [];
  const assetIds = [...new Set([...ids.assets, ...eq.map((e) => Number(e.asset_id)), ...rooms.map((r) => Number(r.asset_id))])];
  const assets = assetIds.length ? await q(x, sql`
    SELECT a.id, a.name, (a.status IS DISTINCT FROM 'ARCHIVED' AND COALESCE(a.lock_state, 'NONE') = 'NONE') AS writable
      FROM assets a WHERE a.account_id = ${accountId} AND a.deleted_at IS NULL AND a.id = ANY(${intArray(assetIds)})`) : [];
  return {
    assets: new Map(assets.map((a) => [Number(a.id), { id: Number(a.id), name: String(a.name ?? ''), writable: a.writable === true }])),
    rooms: new Map(rooms.map((r) => [Number(r.id), { id: Number(r.id), name: String(r.name ?? ''), assetId: Number(r.asset_id) }])),
    equipments: new Map(eq.map((e) => [Number(e.id), {
      id: Number(e.id), name: String(e.name ?? ''), assetId: Number(e.asset_id), roomId: e.room_ok === true ? n(e.substructure_id) : null,
    }])),
  };
}

// ── Lecture ─────────────────────────────────────────────────────────────────

export interface DocumentTargetItem {
  id: number;
  name: string;
  /** Bien porteur (pièce, équipement) ; le bien lui-même pour un bien. */
  assetId: number;
  /** Pièce de l'équipement (si définie). */
  roomId?: number | null;
  provenance: TargetProvenance;
  /** Cible portée par les colonnes historiques (principal du document). */
  principal: boolean;
  /** Cible déduite d'une autre (bien d'une pièce / d'un équipement, pièce d'un équipement), non choisie en propre. */
  implied: boolean;
  /** Cible impliquante (équipement ou pièce) — affichage « via ». */
  via?: { kind: 'room' | 'equipment'; id: number; name: string } | null;
}

export interface DocumentTargetsView {
  assets: DocumentTargetItem[];
  rooms: DocumentTargetItem[];
  equipments: DocumentTargetItem[];
}

/** Sélection courante d'un document, bornée au compte ; `null` si le document est absent du compte. */
export async function readDocumentTargets(x: TargetsExecutor, accountId: number, fileId: number): Promise<DocumentTargetsView | null> {
  const st = await readFileState(x, accountId, fileId);
  if (!st) return null;
  const sel = currentSelection(st.columns, st.active);
  const cat = await readCatalog(x, accountId, { assets: sel.assetIds, rooms: sel.roomIds, equipments: sel.equipmentIds });
  // Cibles d'un autre compte (relation héritée corrompue) : jamais révélées.
  const known: TargetSelection = {
    assetIds: sel.assetIds.filter((id) => cat.assets.has(id)),
    roomIds: sel.roomIds.filter((id) => cat.rooms.has(id)),
    equipmentIds: sel.equipmentIds.filter((id) => cat.equipments.has(id)),
  };
  const r = resolveSelection(known, cat);
  const origins = (k: string) => st.active.filter((l) => isAttaching(l) && linkKey(l) === k).map((l) => l.origin);
  const mark = (f: string) => st.userEdited?.[f] === true;
  const c = st.columns;
  const assets: DocumentTargetItem[] = [...known.assetIds, ...r.impliedAssetIds].map((id) => {
    const implied = !known.assetIds.includes(id);
    const viaE = implied ? known.equipmentIds.find((e) => cat.equipments.get(e)?.assetId === id) : undefined;
    const viaR = implied && viaE === undefined ? known.roomIds.find((s) => cat.rooms.get(s)?.assetId === id) : undefined;
    const fromColumn = c.assetId === id || c.linkedAssetId === id;
    return {
      id, name: cat.assets.get(id)?.name ?? '', assetId: id, principal: c.assetId === id, implied,
      provenance: provenanceOf(origins(`A:${id}`), mark('assetId'), fromColumn),
      via: viaE !== undefined ? { kind: 'equipment', id: viaE, name: cat.equipments.get(viaE)!.name }
        : viaR !== undefined ? { kind: 'room', id: viaR, name: cat.rooms.get(viaR)!.name } : null,
    };
  });
  const rooms: DocumentTargetItem[] = [...known.roomIds, ...r.impliedRoomIds].filter((id) => cat.rooms.has(id)).map((id) => {
    const implied = !known.roomIds.includes(id);
    const viaE = implied ? known.equipmentIds.find((e) => cat.equipments.get(e)?.roomId === id) : undefined;
    return {
      id, name: cat.rooms.get(id)!.name, assetId: cat.rooms.get(id)!.assetId, principal: c.substructureId === id, implied,
      provenance: provenanceOf(origins(`S:${id}`), mark('substructureId') || mark('assetId'), c.substructureId === id),
      via: viaE !== undefined ? { kind: 'equipment', id: viaE, name: cat.equipments.get(viaE)!.name } : null,
    };
  });
  const equipments: DocumentTargetItem[] = known.equipmentIds.map((id) => {
    const e = cat.equipments.get(id)!;
    return {
      id, name: e.name, assetId: e.assetId, roomId: e.roomId, principal: c.equipmentId === id, implied: false,
      provenance: provenanceOf(origins(`E:${id}`), mark('equipmentId'), c.equipmentId === id), via: null,
    };
  });
  return { assets, rooms, equipments };
}

export interface TargetOptionGroup {
  asset: { id: number; name: string; category: string | null; writable: boolean };
  rooms: Array<{ id: number; name: string }>;
  equipments: Array<{ id: number; name: string; roomId: number | null; archived: boolean }>;
}

/** Nombre maximal de biens proposés (même borne que les listes de biens du tiroir). */
export const TARGET_OPTIONS_MAX_ASSETS = 200;

/** Cibles proposées : biens non supprimés du compte (archivés ou verrouillés signalés), pièces et équipements de chacun. */
export async function listTargetOptions(x: TargetsExecutor, accountId: number): Promise<TargetOptionGroup[]> {
  const assets = await q(x, sql`
    SELECT a.id, a.name, a.category, (a.status IS DISTINCT FROM 'ARCHIVED' AND COALESCE(a.lock_state, 'NONE') = 'NONE') AS writable
      FROM assets a WHERE a.account_id = ${accountId} AND a.deleted_at IS NULL
     ORDER BY lower(a.name), a.id LIMIT ${TARGET_OPTIONS_MAX_ASSETS}`);
  const ids = assets.map((a) => Number(a.id));
  if (!ids.length) return [];
  const rooms = await q(x, sql`SELECT id, name, asset_id FROM substructures WHERE asset_id = ANY(${intArray(ids)}) ORDER BY lower(name), id`);
  const eqs = await q(x, sql`SELECT id, name, asset_id, substructure_id, archived_at FROM equipments WHERE asset_id = ANY(${intArray(ids)}) ORDER BY lower(name), id`);
  return assets.map((a) => {
    const id = Number(a.id);
    const roomIds = new Set(rooms.filter((r) => Number(r.asset_id) === id).map((r) => Number(r.id)));
    return {
      asset: { id, name: String(a.name ?? ''), category: (a.category as string | null) ?? null, writable: a.writable === true },
      rooms: rooms.filter((r) => Number(r.asset_id) === id).map((r) => ({ id: Number(r.id), name: String(r.name ?? '') })),
      equipments: eqs.filter((e) => Number(e.asset_id) === id).map((e) => ({
        id: Number(e.id), name: String(e.name ?? ''),
        roomId: n(e.substructure_id) !== null && roomIds.has(Number(e.substructure_id)) ? Number(e.substructure_id) : null,
        archived: e.archived_at != null,
      })),
    };
  });
}

// ── Écriture ────────────────────────────────────────────────────────────────

export interface ApplyTargetsInput {
  accountId: number;
  fileId: number;
  selection: TargetSelection;
  /** `replace` : la sélection devient exacte (tiroir) ; `add` : cibles ajoutées, rien retiré (dépôt). */
  mode: 'replace' | 'add';
  /**
   * Colonnes déjà écrites par l'appelant dans la même transaction (route
   * PUT du document, qui conserve ses effets historiques) : le service ne
   * les réécrit pas et ne fait que les liens.
   */
  columnsManagedByCaller?: boolean;
  /** Colonnes AVANT l'écriture de l'appelant (`columnsManagedByCaller`) : traces de refus des cibles quittées. */
  previousColumns?: TargetColumns;
}

export interface ApplyTargetsResult {
  columns: TargetColumns;
  columnsChanged: boolean;
  added: number;
  removed: number;
  promoted: number;
  /** Niveaux dont l'ensemble explicite a changé (marques `user_edited_fields`). */
  changed: { assets: boolean; rooms: boolean; equipments: boolean };
  impliedAssetIds: number[];
  impliedRoomIds: number[];
}

/** Valide la sélection pour le compte (lève `TargetSelectionError`) et calcule le principal. */
export async function planDocumentTargets(x: TargetsExecutor, accountId: number, fileId: number, selection: TargetSelection, mode: 'replace' | 'add' = 'replace') {
  const st = await readFileState(x, accountId, fileId);
  if (!st) throw new TargetSelectionError('NOT_FOUND', 'Document introuvable');
  const cur = currentSelection(st.columns, st.active);
  const merged: TargetSelection = mode === 'add'
    ? {
      assetIds: [...new Set([...cur.assetIds, ...selection.assetIds])],
      roomIds: [...new Set([...cur.roomIds, ...selection.roomIds])],
      equipmentIds: [...new Set([...cur.equipmentIds, ...selection.equipmentIds])],
    }
    : selection;
  const cat = await readCatalog(x, accountId, {
    assets: [...merged.assetIds, ...cur.assetIds], rooms: [...merged.roomIds, ...cur.roomIds], equipments: [...merged.equipmentIds, ...cur.equipmentIds],
  });
  assertSelectionKnown(selection, cat);
  // Cible ACTUELLE devenue inconnue (autre compte, supprimée) : ignorée, jamais réécrite.
  const sel: TargetSelection = {
    assetIds: merged.assetIds.filter((id) => cat.assets.has(id)),
    roomIds: merged.roomIds.filter((id) => cat.rooms.has(id)),
    equipmentIds: merged.equipmentIds.filter((id) => cat.equipments.has(id)),
  };
  const r = resolveSelection(sel, cat);
  // Nouveau lien vers un bien verrouillé / archivé : refusé (les liens existants restent).
  const curEff = new Set(resolveSelection({
    assetIds: cur.assetIds.filter((id) => cat.assets.has(id)), roomIds: cur.roomIds.filter((id) => cat.rooms.has(id)),
    equipmentIds: cur.equipmentIds.filter((id) => cat.equipments.has(id)),
  }, cat).effectiveAssetIds);
  const nouveaux = [
    ...sel.assetIds.filter((id) => !cur.assetIds.includes(id)),
    ...sel.roomIds.filter((id) => !cur.roomIds.includes(id)).map((id) => cat.rooms.get(id)!.assetId),
    ...sel.equipmentIds.filter((id) => !cur.equipmentIds.includes(id)).map((id) => cat.equipments.get(id)!.assetId),
  ];
  const bloques = [...new Set(nouveaux.filter((a) => cat.assets.get(a)?.writable === false && !curEff.has(a)))];
  if (bloques.length) throw new TargetSelectionError('ASSET_LOCKED', 'Ce bien ne peut pas recevoir de nouveau document pour le moment', bloques.map((a) => `asset:${a}`));
  const columns = mode === 'add' && st.columns.assetId !== null ? st.columns : principalColumns(st.columns, r, cat);
  return { state: st, current: cur, selection: sel, resolved: r, catalog: cat, columns };
}

/**
 * Applique la sélection (dans la transaction de l'appelant). Idempotent :
 * rejoué avec la même sélection, rien ne change.
 */
export async function applyDocumentTargets(x: TargetsExecutor, input: ApplyTargetsInput): Promise<ApplyTargetsResult> {
  const { accountId, fileId, mode } = input;
  // Verrou du document : deux enregistrements concurrents ne se mélangent pas.
  await q(x, sql`SELECT 1 FROM asset_files WHERE id = ${fileId} AND account_id = ${accountId} FOR UPDATE`);
  const p = await planDocumentTargets(x, accountId, fileId, input.selection, mode);
  const before = input.previousColumns ?? p.state.columns;
  const cols = p.columns;
  const columnsChanged = before.assetId !== cols.assetId || before.linkedAssetId !== cols.linkedAssetId
    || before.substructureId !== cols.substructureId || before.equipmentId !== cols.equipmentId || before.linkedRoomId !== cols.linkedRoomId;
  const changed = {
    assets: levelChanged(p.current.assetIds, p.selection.assetIds),
    rooms: levelChanged(p.current.roomIds, p.selection.roomIds),
    equipments: levelChanged(p.current.equipmentIds, p.selection.equipmentIds),
  };
  if (!input.columnsManagedByCaller) {
    const marques: Record<string, boolean> = {};
    if (mode === 'replace') {
      if (changed.assets || p.state.userEdited.assetId === true) marques.assetId = true;
      if (changed.rooms || p.state.userEdited.substructureId === true) marques.substructureId = true;
      if (changed.equipments || p.state.userEdited.equipmentId === true) marques.equipmentId = true;
    }
    if (columnsChanged || Object.keys(marques).length) {
      // Déclencheur 0221 : liens LEGACY_COLUMN réalignés dans la même transaction.
      await x.execute(sql`
        UPDATE asset_files
           SET asset_id = ${cols.assetId}, linked_asset_id = ${cols.linkedAssetId}, substructure_id = ${cols.substructureId},
               equipment_id = ${cols.equipmentId}, linked_room_id = ${cols.linkedRoomId},
               user_edited_fields = COALESCE(user_edited_fields, '{}'::jsonb) || ${JSON.stringify(marques)}::jsonb,
               updated_at = now()
         WHERE id = ${fileId} AND account_id = ${accountId}`);
    }
  }
  const active = await readActiveLinks(x, accountId, fileId);
  const d = diffLinks(active, p.resolved, p.catalog, mode);
  for (const l of d.remove) {
    await x.execute(sql`
      UPDATE document_asset_links SET status = 'REMOVED', removed_at = now(), updated_at = now()
       WHERE id = ${l.id} AND account_id = ${accountId} AND status = 'ACTIVE'`);
  }
  // Trace du refus (exclusion mémorisée) : une cible retirée par l'utilisateur n'est jamais remise
  // automatiquement (`userRefusedEquipments`, T3). Aussi pour une cible quittant les colonnes.
  if (mode === 'replace') {
    const retirees = new Map<string, { assetId: number | null; substructureId: number | null; equipmentId: number | null; roomId: number | null }>();
    for (const l of d.remove) {
      if (l.origin === 'USER') continue; // un lien USER REMOVED est déjà la trace
      retirees.set(linkKey(l)!, { assetId: l.assetId, substructureId: l.substructureId, equipmentId: l.equipmentId, roomId: l.roomId });
    }
    const quitte = (k: string, t: { assetId: number | null; substructureId: number | null; equipmentId: number | null }) => {
      if (!retirees.has(k)) retirees.set(k, { ...t, roomId: null });
    };
    const assetOf = (kind: 'room' | 'equipment', id: number) => (kind === 'room' ? p.catalog.rooms.get(id)?.assetId : p.catalog.equipments.get(id)?.assetId) ?? null;
    if (before.equipmentId !== null && !p.selection.equipmentIds.includes(before.equipmentId)) {
      quitte(`E:${before.equipmentId}`, { assetId: assetOf('equipment', before.equipmentId), substructureId: null, equipmentId: before.equipmentId });
    }
    if (before.substructureId !== null && !p.selection.roomIds.includes(before.substructureId)) {
      quitte(`S:${before.substructureId}`, { assetId: assetOf('room', before.substructureId), substructureId: before.substructureId, equipmentId: null });
    }
    for (const a of [before.assetId, before.linkedAssetId]) {
      if (a !== null && !p.resolved.effectiveAssetIds.includes(a)) quitte(`A:${a}`, { assetId: a, substructureId: null, equipmentId: null });
    }
    for (const t of retirees.values()) {
      if (t.assetId === null && t.equipmentId === null && t.substructureId === null && t.roomId === null) continue;
      await x.execute(sql`
        INSERT INTO document_asset_links (account_id, file_id, asset_id, room_id, substructure_id, equipment_id, link_role, origin, confidence, status, removed_at)
        SELECT ${accountId}, ${fileId}, ${t.assetId}, ${t.roomId}, ${t.substructureId}, ${t.equipmentId}, 'SECONDARY', 'USER', 1, 'REJECTED', now()
         WHERE NOT EXISTS (SELECT 1 FROM document_asset_links r
                            WHERE r.file_id = ${fileId} AND r.origin = 'USER' AND r.status IN ('REJECTED', 'REMOVED')
                              AND COALESCE(r.asset_id, 0) = ${t.assetId ?? 0} AND COALESCE(r.substructure_id, 0) = ${t.substructureId ?? 0}
                              AND COALESCE(r.equipment_id, 0) = ${t.equipmentId ?? 0} AND COALESCE(r.room_id, 0) = ${t.roomId ?? 0})`);
    }
  }
  for (const l of d.promote) {
    await x.execute(sql`
      UPDATE document_asset_links SET link_role = 'SECONDARY', origin = 'USER', confidence = 1, updated_at = now()
       WHERE id = ${l.id} AND account_id = ${accountId} AND status = 'ACTIVE'`);
  }
  let added = 0;
  for (const t of d.add) {
    const r = await q(x, sql`
      INSERT INTO document_asset_links (account_id, file_id, asset_id, substructure_id, equipment_id, link_role, origin, confidence, status)
      VALUES (${accountId}, ${fileId}, ${t.assetId}, ${t.substructureId}, ${t.equipmentId}, 'SECONDARY', 'USER', 1, 'ACTIVE')
      ON CONFLICT DO NOTHING RETURNING id`);
    added += r.length;
  }
  return {
    columns: cols, columnsChanged, added, removed: d.remove.length, promoted: d.promote.length, changed,
    impliedAssetIds: p.resolved.impliedAssetIds, impliedRoomIds: p.resolved.impliedRoomIds,
  };
}
