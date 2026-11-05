/**
 * Lot 111I — sélection MULTIPLE des rattachements d'un document, côté écran
 * (règles pures, partagées par le tiroir « Modifier le document » et l'ajout
 * de document). Mêmes implications que le serveur
 * (`services/documents/document-targets/plan.ts`) : une pièce ou un
 * équipement implique son bien ; un équipement implique sa pièce.
 */

export interface TargetOptionGroupView {
  asset: { id: number; name: string; category: string | null; writable: boolean };
  rooms: Array<{ id: number; name: string }>;
  equipments: Array<{ id: number; name: string; roomId: number | null; archived?: boolean }>;
}

export interface TargetsValue {
  assetIds: number[];
  roomIds: number[];
  equipmentIds: number[];
}

export const EMPTY_TARGETS: TargetsValue = { assetIds: [], roomIds: [], equipmentIds: [] };

interface Index {
  assetName: Map<number, string>;
  room: Map<number, { name: string; assetId: number }>;
  equipment: Map<number, { name: string; assetId: number; roomId: number | null }>;
}

export function indexGroups(groups: readonly TargetOptionGroupView[]): Index {
  const assetName = new Map<number, string>();
  const room = new Map<number, { name: string; assetId: number }>();
  const equipment = new Map<number, { name: string; assetId: number; roomId: number | null }>();
  for (const g of groups) {
    assetName.set(g.asset.id, g.asset.name);
    for (const r of g.rooms) room.set(r.id, { name: r.name, assetId: g.asset.id });
    for (const e of g.equipments) equipment.set(e.id, { name: e.name, assetId: g.asset.id, roomId: e.roomId });
  }
  return { assetName, room, equipment };
}

export interface ImpliedChip { id: number; via: string; viaKind: 'room' | 'equipment' }

/**
 * Libellé d'une cible DÉDUITE (décision PO 05/11) : « par l'équipement Four »,
 * « par la pièce Cuisine ». Constante unique, partagée par le sélecteur et la fiche.
 */
export function impliedLabel(kind: 'room' | 'equipment', name: string): string {
  return kind === 'equipment' ? `par l’équipement ${name}` : `par la pièce ${name}`;
}

/** Biens et pièces IMPLIQUÉS (non choisis en propre) par la sélection. */
export function impliedTargets(groups: readonly TargetOptionGroupView[], v: TargetsValue): { assets: ImpliedChip[]; rooms: ImpliedChip[] } {
  const ix = indexGroups(groups);
  const assets: ImpliedChip[] = [];
  const rooms: ImpliedChip[] = [];
  for (const id of v.equipmentIds) {
    const e = ix.equipment.get(id);
    if (!e) continue;
    if (!v.assetIds.includes(e.assetId) && !assets.some((a) => a.id === e.assetId)) assets.push({ id: e.assetId, via: e.name, viaKind: 'equipment' });
    if (e.roomId != null && !v.roomIds.includes(e.roomId) && !rooms.some((r) => r.id === e.roomId)) rooms.push({ id: e.roomId, via: e.name, viaKind: 'equipment' });
  }
  for (const id of v.roomIds) {
    const r = ix.room.get(id);
    if (r && !v.assetIds.includes(r.assetId) && !assets.some((a) => a.id === r.assetId)) assets.push({ id: r.assetId, via: r.name, viaKind: 'room' });
  }
  return { assets, rooms };
}

const toggled = (arr: readonly number[], id: number): number[] => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

export function toggleAsset(v: TargetsValue, id: number): TargetsValue {
  return { ...v, assetIds: toggled(v.assetIds, id) };
}
export function toggleRoom(v: TargetsValue, id: number): TargetsValue {
  return { ...v, roomIds: toggled(v.roomIds, id) };
}
export function toggleEquipment(v: TargetsValue, id: number): TargetsValue {
  return { ...v, equipmentIds: toggled(v.equipmentIds, id) };
}

/**
 * Retirer un BIEN retire aussi ses pièces et ses équipements choisis (sinon il
 * resterait impliqué) : une seule action « dissocier ce bien ».
 */
export function removeAsset(groups: readonly TargetOptionGroupView[], v: TargetsValue, assetId: number): TargetsValue {
  const ix = indexGroups(groups);
  return {
    assetIds: v.assetIds.filter((x) => x !== assetId),
    roomIds: v.roomIds.filter((r) => ix.room.get(r)?.assetId !== assetId),
    equipmentIds: v.equipmentIds.filter((e) => ix.equipment.get(e)?.assetId !== assetId),
  };
}

/** Retirer une PIÈCE retire aussi les équipements choisis qui l'impliquent. */
export function removeRoom(groups: readonly TargetOptionGroupView[], v: TargetsValue, roomId: number): TargetsValue {
  const ix = indexGroups(groups);
  return { ...v, roomIds: v.roomIds.filter((x) => x !== roomId), equipmentIds: v.equipmentIds.filter((e) => ix.equipment.get(e)?.roomId !== roomId) };
}

/** Filtre insensible à la casse et aux accents. */
export function matchesFilter(label: string, filter: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const f = norm(filter.trim());
  return !f || norm(label).includes(f);
}

/** Groupes ordonnés : biens de la sélection (explicites ou impliqués) d'abord, puis les autres. */
export function orderedGroups(groups: readonly TargetOptionGroupView[], v: TargetsValue): TargetOptionGroupView[] {
  const imp = impliedTargets(groups, v);
  const sel = new Set([...v.assetIds, ...imp.assets.map((a) => a.id)]);
  return [...groups.filter((g) => sel.has(g.asset.id)), ...groups.filter((g) => !sel.has(g.asset.id))];
}

/** Corps JSON des listes (routes d'édition). */
export function targetsBody(v: TargetsValue): { assetIds: number[]; substructureIds: number[]; equipmentIds: number[] } {
  return { assetIds: [...v.assetIds], substructureIds: [...v.roomIds], equipmentIds: [...v.equipmentIds] };
}

/** Sélection depuis la réponse `GET /api/documents/:id/targets` (cibles impliquées exclues). */
export function valueFromTargetsView(t: { assets: Array<{ id: number; implied: boolean }>; rooms: Array<{ id: number; implied: boolean }>; equipments: Array<{ id: number }> } | null | undefined): TargetsValue {
  if (!t) return EMPTY_TARGETS;
  return {
    assetIds: t.assets.filter((a) => !a.implied).map((a) => a.id),
    roomIds: t.rooms.filter((r) => !r.implied).map((r) => r.id),
    equipmentIds: t.equipments.map((e) => e.id),
  };
}

/**
 * Principal (pure) d'une sélection NOUVELLE (dépôt) : même règle que le
 * serveur sans principal antérieur — premier bien choisi, sinon bien du
 * premier équipement, sinon de la première pièce ; pièce et équipement :
 * les premiers choisis SUR ce bien.
 */
export function principalOf(groups: readonly TargetOptionGroupView[], v: TargetsValue): { assetId: number | null; roomId: number | null; equipmentId: number | null } {
  const ix = indexGroups(groups);
  const asset = v.assetIds[0]
    ?? v.equipmentIds.map((e) => ix.equipment.get(e)?.assetId).find((x) => x != null)
    ?? v.roomIds.map((r) => ix.room.get(r)?.assetId).find((x) => x != null)
    ?? null;
  if (asset === null) return { assetId: null, roomId: null, equipmentId: null };
  return {
    assetId: asset,
    roomId: v.roomIds.find((r) => ix.room.get(r)?.assetId === asset) ?? null,
    equipmentId: v.equipmentIds.find((e) => ix.equipment.get(e)?.assetId === asset) ?? null,
  };
}

/** La sélection dépasse-t-elle son principal (cibles complémentaires à poser après le dépôt) ? */
export function hasExtraTargets(v: TargetsValue, p: { assetId: number | null; roomId: number | null; equipmentId: number | null }): boolean {
  return v.assetIds.some((a) => a !== p.assetId) || v.roomIds.some((r) => r !== p.roomId) || v.equipmentIds.some((e) => e !== p.equipmentId);
}
