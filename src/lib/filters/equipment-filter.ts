/**
 * Filtre « Équipement » — partagé par « Mes documents » (et l'onglet
 * Documents d'un bien) et « Mon agenda ». Lot 71 (71C).
 *
 * Fichier sans dépendance serveur : l'écran et les routes l'importent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS VALEURS, UNE SEULE SÉLECTION
 *
 *   · `all`   — « Tous (bien et équipements) », par défaut, jamais transmis ;
 *   · `asset` — « Bien uniquement » : les éléments du bien qui ne sont
 *               associés à AUCUN équipement de ce bien ;
 *   · `<id>`  — un équipement : seulement les éléments EXPLICITEMENT associés
 *               à cet équipement en base.
 *
 * Le filtre n'a de sens qu'avec au moins un bien sélectionné (ou dans
 * l'onglet d'un bien) qui possède au moins un équipement : sinon il est
 * masqué et, côté serveur, ignoré.
 *
 * ── LES ASSOCIATIONS VIENNENT DE LA BASE, JAMAIS DU NOM ───────────────────
 *
 * Aucun libellé de document ou d'événement n'est lu pour décider : un
 * document sans association reste un document « du bien », même s'il
 * s'intitule « Facture chaudière ». C'est voulu : le filtre ne doit pas
 * masquer un défaut de rattachement en le « devinant ».
 * ══════════════════════════════════════════════════════════════════════════
 */

export const EQUIPMENT_FILTER_ALL = 'all';
export const EQUIPMENT_FILTER_ASSET_ONLY = 'asset';
/** Équipements proposés au plus (bornage de la requête). */
export const EQUIPMENT_FILTER_MAX_OPTIONS = 300;

/** `all` | `asset` | identifiant d'équipement en chaîne (`'42'`). */
export type EquipmentFilterValue = string;

/**
 * Lecture défensive (URL, paramètre d'API, instantané) : toute valeur
 * illisible retombe sur `all` — un lien abîmé rend la liste complète.
 */
export function parseEquipmentFilter(raw: string | null | undefined): EquipmentFilterValue {
  if (raw === EQUIPMENT_FILTER_ASSET_ONLY) return EQUIPMENT_FILTER_ASSET_ONLY;
  if (raw && /^\d{1,10}$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return String(n);
  }
  return EQUIPMENT_FILTER_ALL;
}

/** Valeur à transmettre (URL, API) ; `null` pour « Tous » (paramètre absent). */
export function equipmentFilterParam(value: EquipmentFilterValue | null | undefined): string | null {
  const v = parseEquipmentFilter(value);
  return v === EQUIPMENT_FILTER_ALL ? null : v;
}

export function isEquipmentFilterActive(value: EquipmentFilterValue | null | undefined): boolean {
  return equipmentFilterParam(value) !== null;
}

/** Identifiant d'équipement sélectionné, ou `null` (`all`, `asset`). */
export function selectedEquipmentId(value: EquipmentFilterValue | null | undefined): number | null {
  const v = parseEquipmentFilter(value);
  return v === EQUIPMENT_FILTER_ALL || v === EQUIPMENT_FILTER_ASSET_ONLY ? null : Number(v);
}

/** Équipement d'un bien sélectionné, tel que le serveur le décrit. */
export interface EquipmentFacetItem {
  id: number;
  name: string;
  assetId: number;
  assetName: string;
  archived?: boolean;
  /** Éléments associés (périmètre courant) ; `null` si non compté. */
  count: number | null;
}

export interface EquipmentFacet {
  /** Éléments du ou des biens, équipements compris (« Tous »). */
  all: number | null;
  /** Éléments du ou des biens sans association à l'un de leurs équipements. */
  assetOnly: number | null;
  items: EquipmentFacetItem[];
}

export interface EquipmentChoice {
  value: EquipmentFilterValue;
  label: string;
  /** Nom accessible complet (« Chaudière, équipement de Maison »). */
  ariaLabel?: string;
  count: number | null;
  active: boolean;
}

export interface EquipmentFilterModel {
  /** Faux : aucun bien sélectionné, ou aucun équipement — le filtre est masqué. */
  visible: boolean;
  /** Plusieurs biens portent des équipements : options groupées par bien. */
  multi: boolean;
  /** « Tous (bien et équipements) », « Bien(s) uniquement ». */
  general: EquipmentChoice[];
  /** Un groupe par bien (un seul, sans titre, si `multi` est faux). */
  groups: Array<{ assetId: number; assetName: string; options: EquipmentChoice[] }>;
  /** Valeur effectivement retenue (une valeur inconnue retombe sur `all`). */
  value: EquipmentFilterValue;
  /** Libellé de la pastille « Filtré par … », `null` pour « Tous ». */
  chipLabel: string | null;
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/**
 * Modèle d'affichage du filtre, à partir des équipements des biens
 * sélectionnés. Pur.
 *
 * Un équipement archivé n'est proposé que s'il porte des éléments (ou s'il
 * est sélectionné) : ses documents restent consultables sans encombrer la
 * liste des équipements en service.
 */
export function buildEquipmentFilterModel(
  facet: EquipmentFacet | null | undefined,
  rawValue: EquipmentFilterValue | null | undefined,
  selectedAssetCount: number,
): EquipmentFilterModel {
  const value = parseEquipmentFilter(rawValue);
  const items = (facet?.items ?? []).filter(
    (e) => !e.archived || (e.count ?? 0) > 0 || String(e.id) === value,
  );
  const hidden: EquipmentFilterModel = {
    visible: false, multi: false, general: [], groups: [], value: EQUIPMENT_FILTER_ALL, chipLabel: null,
  };
  if (selectedAssetCount <= 0 || items.length === 0) return hidden;

  const byAsset = new Map<number, { assetId: number; assetName: string; items: EquipmentFacetItem[] }>();
  for (const e of items) {
    const g = byAsset.get(e.assetId) ?? { assetId: e.assetId, assetName: e.assetName, items: [] };
    g.items.push(e);
    byAsset.set(e.assetId, g);
  }
  const multi = byAsset.size > 1 || selectedAssetCount > 1;
  const knownIds = new Set(items.map((e) => String(e.id)));
  // Équipement inconnu (lien ancien, autre bien) : la sélection est conservée
  // pour pouvoir la retirer, mais signalée comme indisponible.
  const unknown = value !== EQUIPMENT_FILTER_ALL && value !== EQUIPMENT_FILTER_ASSET_ONLY && !knownIds.has(value);

  const general: EquipmentChoice[] = [
    { value: EQUIPMENT_FILTER_ALL, label: 'Tous (bien et équipements)', count: facet?.all ?? null, active: value === EQUIPMENT_FILTER_ALL },
    {
      value: EQUIPMENT_FILTER_ASSET_ONLY,
      label: selectedAssetCount > 1 ? 'Biens uniquement' : 'Bien uniquement',
      ariaLabel: selectedAssetCount > 1 ? 'Biens uniquement, sans les éléments de leurs équipements' : 'Bien uniquement, sans les éléments de ses équipements',
      count: facet?.assetOnly ?? null,
      active: value === EQUIPMENT_FILTER_ASSET_ONLY,
    },
  ];
  const groups: EquipmentFilterModel['groups'] = [...byAsset.values()]
    .sort((a, b) => collator.compare(a.assetName, b.assetName))
    .map((g) => ({
      assetId: g.assetId,
      assetName: g.assetName,
      options: [...g.items]
        .sort((a, b) => collator.compare(a.name, b.name))
        .map((e) => ({
          value: String(e.id),
          label: e.archived ? `${e.name} (archivé)` : e.name,
          ariaLabel: `${e.name}${e.archived ? ' (archivé)' : ''}, équipement de ${g.assetName}`,
          count: e.count,
          active: value === String(e.id),
        })),
    }));
  if (unknown) {
    groups.push({
      assetId: 0,
      assetName: '',
      options: [{ value, label: 'Équipement indisponible', ariaLabel: 'Équipement indisponible (supprimé ou d’un autre bien)', count: 0, active: true }],
    });
  }

  const selected = items.find((e) => String(e.id) === value);
  const chipLabel = value === EQUIPMENT_FILTER_ALL
    ? null
    : value === EQUIPMENT_FILTER_ASSET_ONLY
      ? general[1].label
      : selected
        // Plusieurs biens : le bien préfixe l'équipement, pour ne pas confondre
        // deux « Chaudière ».
        ? (multi ? `${selected.assetName} · ${selected.name}` : selected.name)
        : 'Équipement indisponible';

  return { visible: true, multi, general, groups, value, chipLabel };
}
