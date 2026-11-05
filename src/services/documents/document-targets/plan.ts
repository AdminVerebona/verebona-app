/**
 * Lot 111I — rattachement MULTIPLE d'un document (plusieurs biens, pièces,
 * équipements) : règles PURES (aucun accès base), testées unitairement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE CANONIQUE : `document_asset_links` (0221 / 0229), liens ACTIFS de
 * rôle PRIMARY ou SECONDARY. Un lien = une cible :
 *   · bien       (asset_id seul)                  clé `A:<id>`
 *   · pièce      (substructure_id, bien déduit)    clé `S:<id>`
 *   · équipement (equipment_id, bien déduit)       clé `E:<id>`
 *   · pièce historique `rooms` (room_id)           clé `R:<id>` (lecture seule)
 * Un lien MENTIONED (cible seulement citée) n'est JAMAIS un rattachement.
 *
 * COLONNES HISTORIQUES = « PRINCIPAL » DÉRIVÉ (transition) :
 * `asset_files.asset_id` / `substructure_id` / `equipment_id` restent lues
 * par de nombreux modules (titres, T3, exports, Duo, TCO…). Elles portent un
 * triplet COHÉRENT (pièce et équipement du bien principal) choisi parmi la
 * sélection ; le déclencheur 0221 les reflète en liens LEGACY_COLUMN. Les
 * autres cibles sont des liens USER (rôle SECONDARY).
 *
 * IMPLICATIONS : une pièce ou un équipement implique son bien ; un
 * équipement implique sa pièce (si définie). Implications CALCULÉES à la
 * lecture (jamais un lien matérialisé : un équipement déplacé de pièce ne
 * laisse pas de lien périmé) — mêmes règles que `room-scope.service`
 * (« Via [équipement] ») et `asset-document-scope` (le lien d'équipement
 * porte son bien).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Nombre maximal de cibles par niveau (bien, pièce, équipement) dans une demande. */
export const DOCUMENT_TARGETS_MAX_PER_LEVEL = 50;

export type TargetLevel = 'asset' | 'room' | 'equipment';

/** Sélection EXPLICITE demandée (identifiants, ordre conservé : le premier sert de principal). */
export interface TargetSelection {
  assetIds: number[];
  roomIds: number[];
  equipmentIds: number[];
}

/** Cibles connues du compte (lues en base, déjà bornées au compte). */
export interface TargetCatalog {
  assets: ReadonlyMap<number, { id: number; name: string; writable: boolean }>;
  rooms: ReadonlyMap<number, { id: number; name: string; assetId: number }>;
  equipments: ReadonlyMap<number, { id: number; name: string; assetId: number; roomId: number | null }>;
}

/** Colonnes historiques du document. */
export interface TargetColumns {
  assetId: number | null;
  linkedAssetId: number | null;
  substructureId: number | null;
  equipmentId: number | null;
  linkedRoomId: number | null;
  /** Bien de la pièce historique `linked_room_id` (lu en base). */
  linkedRoomAssetId?: number | null;
}

/** Lien ACTIF du document (tous rôles, toutes origines). */
export interface ActiveTargetLink {
  id: number;
  assetId: number | null;
  roomId: number | null;
  substructureId: number | null;
  equipmentId: number | null;
  linkRole: string;
  origin: string;
}

export type TargetKey = `${'A' | 'S' | 'E' | 'R'}:${number}`;

/** Clé de cible d'un lien (l'équipement prime sur la pièce, la pièce sur le bien). */
export function linkKey(l: Pick<ActiveTargetLink, 'assetId' | 'roomId' | 'substructureId' | 'equipmentId'>): TargetKey | null {
  if (l.equipmentId != null) return `E:${l.equipmentId}`;
  if (l.substructureId != null) return `S:${l.substructureId}`;
  if (l.roomId != null) return `R:${l.roomId}`;
  if (l.assetId != null) return `A:${l.assetId}`;
  return null;
}

const ATTACHING = new Set(['PRIMARY', 'SECONDARY']);
export const isAttaching = (l: Pick<ActiveTargetLink, 'linkRole'>): boolean => ATTACHING.has(l.linkRole);

export class TargetSelectionError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'TOO_MANY' | 'NOT_FOUND' | 'ASSET_LOCKED', message: string, readonly refs: string[] = []) {
    super(message);
    this.name = 'TargetSelectionError';
  }
}

/** Identifiant positif, sinon NaN (refus) ; `null` / 0 / '' : absent. */
function idOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 0 || v === '0') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : NaN;
}

/** Liste d'identifiants (dédoublonnée, ordre conservé) ; `undefined` si le champ est absent. */
export function parseIdList(v: unknown, label: string): number[] | undefined {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v)) throw new TargetSelectionError('INVALID_INPUT', `${label} : liste attendue`);
  const out: number[] = [];
  for (const x of v) {
    const n = idOf(x);
    if (n === null) continue;
    if (Number.isNaN(n)) throw new TargetSelectionError('INVALID_INPUT', `${label} : identifiant invalide`);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > DOCUMENT_TARGETS_MAX_PER_LEVEL) {
    throw new TargetSelectionError('TOO_MANY', `${label} : au plus ${DOCUMENT_TARGETS_MAX_PER_LEVEL} éléments`);
  }
  return out;
}

/**
 * Corps de requête → sélection. Listes (`assetIds`, `substructureIds` /
 * `roomIds`, `equipmentIds`) ; à défaut, anciens champs à valeur unique
 * (`assetId`, `substructureId`, `equipmentId`) complétés par la sélection
 * actuelle pour les niveaux non envoyés. `null` : aucun champ de rattachement.
 */
export function selectionFromBody(body: Record<string, unknown>, current: TargetSelection | null): TargetSelection | null {
  const assets = parseIdList(body.assetIds, 'Biens');
  const rooms = parseIdList(body.substructureIds ?? body.roomIds, 'Pièces');
  const equips = parseIdList(body.equipmentIds, 'Équipements');
  if (assets === undefined && rooms === undefined && equips === undefined) return null;
  return {
    assetIds: assets ?? current?.assetIds ?? [],
    roomIds: rooms ?? current?.roomIds ?? [],
    equipmentIds: equips ?? current?.equipmentIds ?? [],
  };
}

/** Le corps porte-t-il au moins une LISTE de rattachement ? */
export function bodyHasTargetLists(body: Record<string, unknown>): boolean {
  return Array.isArray(body.assetIds) || Array.isArray(body.substructureIds) || Array.isArray(body.roomIds) || Array.isArray(body.equipmentIds);
}

/** Toutes les cibles demandées sont-elles connues du compte ? Lève NOT_FOUND sinon (anti-énumération : aucun détail). */
export function assertSelectionKnown(sel: TargetSelection, cat: TargetCatalog): void {
  const manquants = [
    ...sel.assetIds.filter((id) => !cat.assets.has(id)).map((id) => `asset:${id}`),
    ...sel.roomIds.filter((id) => !cat.rooms.has(id)).map((id) => `substructure:${id}`),
    ...sel.equipmentIds.filter((id) => !cat.equipments.has(id)).map((id) => `equipment:${id}`),
  ];
  if (manquants.length) throw new TargetSelectionError('NOT_FOUND', 'Bien, pièce ou équipement introuvable', manquants);
}

export interface ResolvedSelection {
  explicit: TargetSelection;
  /** Biens impliqués par une pièce ou un équipement, non choisis explicitement. */
  impliedAssetIds: number[];
  /** Pièces impliquées par un équipement, non choisies explicitement. */
  impliedRoomIds: number[];
  /** Biens effectifs (explicites puis impliqués). */
  effectiveAssetIds: number[];
}

/** Implications (pure) : bien de chaque pièce / équipement, pièce de chaque équipement. */
export function resolveSelection(sel: TargetSelection, cat: TargetCatalog): ResolvedSelection {
  const impliedAssets: number[] = [];
  const add = (arr: number[], id: number | null | undefined, exclude: readonly number[]) => {
    if (id != null && !exclude.includes(id) && !arr.includes(id)) arr.push(id);
  };
  for (const e of sel.equipmentIds) add(impliedAssets, cat.equipments.get(e)?.assetId, sel.assetIds);
  for (const r of sel.roomIds) add(impliedAssets, cat.rooms.get(r)?.assetId, sel.assetIds);
  const impliedRooms: number[] = [];
  for (const e of sel.equipmentIds) add(impliedRooms, cat.equipments.get(e)?.roomId ?? null, sel.roomIds);
  return {
    explicit: sel,
    impliedAssetIds: impliedAssets,
    impliedRoomIds: impliedRooms,
    effectiveAssetIds: [...sel.assetIds, ...impliedAssets],
  };
}

/**
 * Colonnes « principal » (pure) : triplet cohérent sur UN bien, en
 * conservant le principal actuel tant qu'il reste sélectionné (aucun
 * déplacement silencieux du bien principal d'un document).
 */
export function principalColumns(cur: TargetColumns, r: ResolvedSelection, cat: TargetCatalog): TargetColumns {
  const eff = r.effectiveAssetIds;
  const firstEquipAsset = r.explicit.equipmentIds.map((e) => cat.equipments.get(e)?.assetId).find((x) => x != null) ?? null;
  const firstRoomAsset = r.explicit.roomIds.map((s) => cat.rooms.get(s)?.assetId).find((x) => x != null) ?? null;
  const asset = cur.assetId != null && eff.includes(cur.assetId)
    ? cur.assetId
    : r.explicit.assetIds[0] ?? firstEquipAsset ?? firstRoomAsset ?? null;
  const pick = <T extends { assetId: number }>(ids: number[], curId: number | null, m: ReadonlyMap<number, T>): number | null => {
    if (asset === null) return null;
    if (curId != null && ids.includes(curId) && m.get(curId)?.assetId === asset) return curId;
    return ids.find((id) => m.get(id)?.assetId === asset) ?? null;
  };
  const linked = cur.linkedAssetId != null && cur.linkedAssetId !== asset && r.explicit.assetIds.includes(cur.linkedAssetId) ? cur.linkedAssetId : null;
  const linkedRoom = cur.linkedRoomId != null && cur.linkedRoomAssetId != null && eff.includes(cur.linkedRoomAssetId) ? cur.linkedRoomId : null;
  return {
    assetId: asset,
    linkedAssetId: linked,
    substructureId: pick(r.explicit.roomIds, cur.substructureId, cat.rooms),
    equipmentId: pick(r.explicit.equipmentIds, cur.equipmentId, cat.equipments),
    linkedRoomId: linkedRoom,
  };
}

/** Clés désirées (cibles EXPLICITES). */
export function desiredKeys(sel: TargetSelection): Set<TargetKey> {
  return new Set<TargetKey>([
    ...sel.assetIds.map((id) => `A:${id}` as TargetKey),
    ...sel.roomIds.map((id) => `S:${id}` as TargetKey),
    ...sel.equipmentIds.map((id) => `E:${id}` as TargetKey),
  ]);
}

export interface LinkTargetSpec { assetId: number; substructureId: number | null; equipmentId: number | null }

export interface LinkDiff {
  /** Liens retirés (REMOVED) : non LEGACY_COLUMN, cible non désirée. */
  remove: ActiveTargetLink[];
  /** Liens MENTIONED de cible désirée : promus SECONDARY / USER (une citation devient un rattachement choisi). */
  promote: ActiveTargetLink[];
  /** Cibles désirées sans lien actif : lien USER SECONDARY à créer. */
  add: LinkTargetSpec[];
}

/**
 * Écart (pure) entre les liens ACTIFS (après réalignement des colonnes par le
 * déclencheur) et la sélection. Mode `add` : jamais de retrait.
 *   · LEGACY_COLUMN : jamais retiré ici (il suit les colonnes) ;
 *   · pièce historique `R:` : retirée seulement si son bien n'est plus effectif ;
 *   · lien MENTIONED : jamais retiré (une citation n'est pas un rattachement).
 */
export function diffLinks(active: readonly ActiveTargetLink[], r: ResolvedSelection, cat: TargetCatalog, mode: 'replace' | 'add'): LinkDiff {
  const want = desiredKeys(r.explicit);
  const remove: ActiveTargetLink[] = [];
  const promote: ActiveTargetLink[] = [];
  const covered = new Set<TargetKey>();
  for (const l of active) {
    const k = linkKey(l);
    if (!k) continue;
    if (!isAttaching(l)) {
      if (want.has(k) && l.origin !== 'LEGACY_COLUMN') promote.push(l);
      if (want.has(k)) covered.add(k);
      continue;
    }
    covered.add(k);
    if (mode === 'add' || l.origin === 'LEGACY_COLUMN' || want.has(k)) continue;
    if (k.startsWith('R:')) {
      if (l.assetId != null && r.effectiveAssetIds.includes(l.assetId)) continue;
    }
    remove.push(l);
  }
  const add: LinkTargetSpec[] = [];
  for (const k of want) {
    if (covered.has(k)) continue;
    const id = Number(k.slice(2));
    if (k.startsWith('A:')) add.push({ assetId: id, substructureId: null, equipmentId: null });
    else if (k.startsWith('S:')) add.push({ assetId: cat.rooms.get(id)!.assetId, substructureId: id, equipmentId: null });
    else if (k.startsWith('E:')) add.push({ assetId: cat.equipments.get(id)!.assetId, substructureId: null, equipmentId: id });
  }
  return { remove, promote, add };
}

/** Sélection ACTUELLE (pure) : colonnes + liens ACTIFS rattachants, ordre « principal d'abord ». */
export function currentSelection(cols: TargetColumns, active: readonly ActiveTargetLink[]): TargetSelection {
  const assets: number[] = [];
  const rooms: number[] = [];
  const equips: number[] = [];
  const push = (arr: number[], id: number | null | undefined) => { if (id != null && !arr.includes(id)) arr.push(id); };
  push(assets, cols.assetId);
  push(rooms, cols.substructureId);
  push(equips, cols.equipmentId);
  push(assets, cols.linkedAssetId);
  const tri = [...active].filter(isAttaching).sort((a, b) => (a.linkRole === b.linkRole ? a.id - b.id : a.linkRole === 'PRIMARY' ? -1 : 1));
  for (const l of tri) {
    const k = linkKey(l);
    if (!k) continue;
    if (k.startsWith('E:')) push(equips, l.equipmentId);
    else if (k.startsWith('S:')) push(rooms, l.substructureId);
    else if (k.startsWith('A:')) push(assets, l.assetId);
  }
  return { assetIds: assets, roomIds: rooms, equipmentIds: equips };
}

/** Provenance affichée d'une cible : choix de l'utilisateur, analyse, ou historique (colonne / reprise). */
export type TargetProvenance = 'USER' | 'AI' | 'HISTORY';

/**
 * Provenance (pure). Une colonne historique marquée « modifiée par
 * l'utilisateur » (`user_edited_fields`) est un choix USER ; un lien USER
 * aussi ; un lien AI une décision de l'analyse ; le reste (colonne non
 * marquée, MIGRATION) l'historique.
 */
export function provenanceOf(origins: readonly string[], userMarked: boolean, fromColumn: boolean): TargetProvenance {
  if (origins.includes('USER') || (fromColumn && userMarked)) return 'USER';
  if (origins.includes('AI')) return 'AI';
  return 'HISTORY';
}

/** Les ensembles explicites diffèrent-ils (ordre ignoré) ? */
export function levelChanged(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return true;
  const s = new Set(a);
  return b.some((x) => !s.has(x));
}
