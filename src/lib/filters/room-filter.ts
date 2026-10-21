/**
 * Filtre « Pièce » — partagé par « Mes documents » (et l'onglet Documents
 * d'un bien) et « Mon agenda ». Lot 75 (75B).
 *
 * Fichier sans dépendance serveur : l'écran et les routes l'importent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE PIÈCE = SES ÉLÉMENTS DIRECTS + CEUX DE SES ÉQUIPEMENTS
 *
 * Sélectionner « Cuisine » rend :
 *   · les éléments DIRECTEMENT associés à la pièce ;
 *   · les éléments des ÉQUIPEMENTS de la pièce (Réfrigérateur → facture,
 *     garantie, manuel), lus à l'instant de la requête : un équipement
 *     déplacé vers « Cellier » emporte aussitôt ses éléments ;
 *   · pour l'agenda, aussi les échéances des documents de la pièce.
 * Un élément trouvé par plusieurs chemins n'apparaît qu'une fois. La
 * résolution est centralisée côté serveur (`services/rooms/room-scope`) :
 * tiroir Pièce, « Mes documents » et « Mon agenda » lisent la même règle.
 *
 * DEUX VALEURS : `all` (« Toutes les pièces », par défaut, jamais transmis)
 * ou l'identifiant d'une pièce (`'42'`). Le filtre n'a de sens qu'avec au
 * moins un bien sélectionné (ou dans l'onglet d'un bien) qui possède au
 * moins une pièce : sinon il est masqué et, côté serveur, ignoré.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const ROOM_FILTER_ALL = 'all';
/** Pièces proposées au plus (bornage de la requête). */
export const ROOM_FILTER_MAX_OPTIONS = 300;

/** `all` | identifiant de pièce en chaîne. */
export type RoomFilterValue = string;

/** Lecture défensive (URL, paramètre d'API) : toute valeur illisible retombe sur `all`. */
export function parseRoomFilter(raw: string | null | undefined): RoomFilterValue {
  if (raw && /^\d{1,10}$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return String(n);
  }
  return ROOM_FILTER_ALL;
}

/** Valeur à transmettre (URL, API) ; `null` pour « Toutes les pièces » (paramètre absent). */
export function roomFilterParam(value: RoomFilterValue | null | undefined): string | null {
  const v = parseRoomFilter(value);
  return v === ROOM_FILTER_ALL ? null : v;
}

export function isRoomFilterActive(value: RoomFilterValue | null | undefined): boolean {
  return roomFilterParam(value) !== null;
}

/** Identifiant de la pièce sélectionnée, ou `null`. */
export function selectedRoomId(value: RoomFilterValue | null | undefined): number | null {
  const p = roomFilterParam(value);
  return p === null ? null : Number(p);
}

/** Pièce d'un bien sélectionné, telle que le serveur la décrit. */
export interface RoomFacetItem {
  id: number;
  name: string;
  assetId: number;
  assetName: string;
  /** Éléments directs + indirects, dédupliqués (périmètre courant) ; `null` si non compté. */
  count: number | null;
}

export interface RoomFacet {
  items: RoomFacetItem[];
}

export interface RoomChoice {
  value: RoomFilterValue;
  label: string;
  ariaLabel?: string;
  count: number | null;
  active: boolean;
}

export interface RoomFilterModel {
  visible: boolean;
  multi: boolean;
  general: RoomChoice[];
  groups: Array<{ assetId: number; assetName: string; options: RoomChoice[] }>;
  value: RoomFilterValue;
  chipLabel: string | null;
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/**
 * Modèle d'affichage du filtre, à partir des pièces des biens sélectionnés.
 * Pur. Les pièces gardent l'ordre du bien (celui de la fiche) ; plusieurs
 * biens : un sous-groupe par bien, et le nom accessible cite le bien.
 */
export function buildRoomFilterModel(
  facet: RoomFacet | null | undefined,
  rawValue: RoomFilterValue | null | undefined,
  selectedAssetCount: number,
): RoomFilterModel {
  const value = parseRoomFilter(rawValue);
  const items = facet?.items ?? [];
  if (selectedAssetCount <= 0 || items.length === 0) {
    return { visible: false, multi: false, general: [], groups: [], value: ROOM_FILTER_ALL, chipLabel: null };
  }
  const byAsset = new Map<number, { assetId: number; assetName: string; items: RoomFacetItem[] }>();
  for (const r of items) {
    const g = byAsset.get(r.assetId) ?? { assetId: r.assetId, assetName: r.assetName, items: [] };
    g.items.push(r);
    byAsset.set(r.assetId, g);
  }
  const multi = byAsset.size > 1 || selectedAssetCount > 1;
  const groups: RoomFilterModel['groups'] = [...byAsset.values()]
    .sort((a, b) => collator.compare(a.assetName, b.assetName))
    .map((g) => ({
      assetId: g.assetId,
      assetName: g.assetName,
      options: g.items.map((r) => ({
        value: String(r.id),
        label: r.name,
        ariaLabel: `${r.name}, pièce de ${g.assetName}`,
        count: r.count,
        active: value === String(r.id),
      })),
    }));
  const selected = items.find((r) => String(r.id) === value);
  return {
    visible: true,
    multi,
    general: [{ value: ROOM_FILTER_ALL, label: 'Toutes les pièces', count: null, active: value === ROOM_FILTER_ALL || !selected }],
    groups,
    // Pièce inconnue (lien ancien, autre bien) : retombe sur « Toutes » —
    // l'écran la retire (`setRoomFilter`) au lieu de filtrer à vide.
    value: selected ? value : ROOM_FILTER_ALL,
    chipLabel: selected ? (multi ? `${selected.assetName} · ${selected.name}` : selected.name) : null,
  };
}
