/**
 * Pièces et équipements d'un élément d'agenda — RÈGLE UNIQUE (lot 103D,
 * ticket « Agenda — Pièces / Équipements seulement pour un logement lié »,
 * remplace le doublon #611).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÈGLE
 *
 *   · Les rubriques « Pièces » et « Équipements » n'EXISTENT que si au moins
 *     un LOGEMENT est rattaché à l'élément d'agenda (aucun titre, compteur,
 *     message « Aucun », champ ni bouton sinon) ;
 *   · seuls les logements effectivement rattachés déterminent les pièces et
 *     équipements associables : jamais ceux des autres biens du compte,
 *     jamais un logement ajouté implicitement pour autoriser une relation ;
 *   · une pièce ou un équipement dont le bien porteur n'est pas un logement
 *     rattaché est INCOMPATIBLE : refusé à l'écriture (code stable
 *     `AGENDA_STRUCTURAL_LINK_INCOMPATIBLE`), écarté des traitements
 *     automatiques (IA, réconciliation), signalé par le contrôle de cohérence
 *     COH-AGENDA-STRUCTURAL-HOUSING ;
 *   · les documents ne sont PAS soumis à cette règle.
 *
 * « Logement » = bien qui gère des pièces et des équipements : liste unique
 * `lib/asset-capabilities` (`assetSupportsRooms` : Maison, Appartement, et les
 * catégories immobilières qui gèrent déjà des pièces). Changer la liste des
 * catégories éligibles se fait EN UN POINT (`asset-capabilities`).
 *
 * Module PUR, sans import serveur : utilisé par le tiroir Agenda (desktop et
 * mobile, consultation et modification), les routes API, les écritures
 * (manuelles et automatiques), le regroupement et le contrôle de cohérence.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { assetSupportsRooms } from '@/lib/asset-capabilities';

/** Code stable du refus d'une association pièce / équipement sans logement rattaché. */
export const AGENDA_STRUCTURAL_LINK_INCOMPATIBLE = 'AGENDA_STRUCTURAL_LINK_INCOMPATIBLE';
/**
 * Code stable du refus de retirer un logement (ou de changer les biens) quand
 * des pièces / équipements de ce logement restent associés : l'appelant doit
 * confirmer la dissociation (liens seulement, aucun objet supprimé).
 */
export const AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS = 'AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS';

/** Bien rattaché (catégorie et sous-type suffisent à la règle). */
export interface HousingAssetRef {
  id: number;
  category: string | null | undefined;
  subtype?: string | null;
}

/** Pièce ou équipement, avec son bien porteur. */
export interface StructuralLinkRef {
  id: number;
  assetId: number | null | undefined;
}

/** Le bien est-il un logement (pièces et équipements gérés) ? */
export function isAgendaHousingAsset(a: Pick<HousingAssetRef, 'category' | 'subtype'>): boolean {
  return !!a.category && assetSupportsRooms({ category: a.category, subtype: a.subtype ?? null });
}

/** Identifiants des logements parmi les biens rattachés (sans doublon, ordre conservé). */
export function agendaHousingAssetIds(linked: readonly HousingAssetRef[]): number[] {
  const out: number[] = [];
  for (const a of linked) if (isAgendaHousingAsset(a) && !out.includes(a.id)) out.push(a.id);
  return out;
}

/** Les rubriques « Pièces » et « Équipements » existent-elles pour ces biens rattachés ? */
export function agendaShowsRoomsAndEquipments(linked: readonly HousingAssetRef[]): boolean {
  return agendaHousingAssetIds(linked).length > 0;
}

/** Objets (pièces, équipements, options) appartenant aux logements donnés. */
export function restrictToHousing<T extends { assetId?: number | null }>(items: readonly T[], housingAssetIds: readonly number[]): T[] {
  const ok = new Set(housingAssetIds);
  return items.filter((i) => i.assetId != null && ok.has(Number(i.assetId)));
}

/** Pièces et équipements INCOMPATIBLES avec les logements rattachés (pur). */
export function incompatibleStructuralLinks(
  housingAssetIds: readonly number[],
  rooms: readonly StructuralLinkRef[],
  equipments: readonly StructuralLinkRef[],
): { roomIds: number[]; equipmentIds: number[] } {
  const ok = new Set(housingAssetIds.map(Number));
  const ko = (l: StructuralLinkRef) => l.assetId == null || !ok.has(Number(l.assetId));
  return {
    roomIds: [...new Set(rooms.filter(ko).map((r) => r.id))],
    equipmentIds: [...new Set(equipments.filter(ko).map((e) => e.id))],
  };
}

/** Nombre total d'incompatibilités. */
export const incompatibleCount = (x: { roomIds: readonly number[]; equipmentIds: readonly number[] }): number =>
  x.roomIds.length + x.equipmentIds.length;

const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

/** Libellés visibles (langage utilisateur, jamais « Opération »). */
export const HOUSING_SCOPE_LABELS = {
  /** Refus serveur (message de l'API). */
  refused: 'Cette pièce ou cet équipement n’appartient à aucun logement associé à cet événement. Associez d’abord le logement concerné.',
  /** Refus serveur : retrait d'un logement dont des pièces / équipements restent associés. */
  dependents: 'Des pièces ou équipements de ce logement sont encore associés à cet événement. Confirmez leur dissociation pour continuer.',
  confirmTitle: 'Dissocier les pièces et équipements ?',
  /** Explication de la confirmation (liens seulement ; rien n'est supprimé). */
  confirmBody: (rooms: number, equipments: number): string => {
    const parts = [rooms ? pluriel(rooms, 'pièce', 'pièces') : null, equipments ? pluriel(equipments, 'équipement', 'équipements') : null].filter(Boolean).join(' et ');
    return `Sans ce logement, ${parts} ne peuvent plus être associés à cet événement. Seule l’association sera retirée : les pièces, les équipements et l’événement restent dans Verebona.`;
  },
  confirmActionSave: 'Dissocier et enregistrer',
  confirmActionRemoveAsset: 'Dissocier et retirer le bien',
  dissociatedToast: 'Association retirée',
} as const;
