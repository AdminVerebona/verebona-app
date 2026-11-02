/**
 * Pièces / équipements d'un élément d'agenda — LECTURES SERVEUR de la règle
 * unique `lib/agenda/housing-scope` (lot 103D). Aucune écriture ici : les
 * écritures (agenda manuel, T4, regroupement, contrôle de cohérence)
 * appellent ces lectures puis appliquent la règle pure.
 *
 * Toutes les lectures sont bornées au compte (un bien, une pièce ou un
 * équipement d'un autre compte n'est jamais lu : il est déjà refusé par le
 * contrôle d'appartenance SEC-07).
 */
import {
  agendaHousingAssetIds, incompatibleStructuralLinks, type HousingAssetRef, type StructuralLinkRef,
} from '@/lib/agenda/housing-scope';
import { intArray, type GroupingRunner } from '@/services/business-operations/grouping/runner';

/** Catégorie et sous-type des biens du compte. */
export async function loadHousingAssetRefs(r: GroupingRunner, accountId: number, assetIds: readonly number[]): Promise<HousingAssetRef[]> {
  if (!assetIds.length) return [];
  const x = await r.q<{ id: number; category: string; subtype: string | null }>(
    `SELECT id, category, subtype FROM assets WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
    [accountId, intArray(assetIds)]);
  return x.map((a) => ({ id: Number(a.id), category: a.category, subtype: a.subtype }));
}

/**
 * Biens qui AUTORISENT des pièces / équipements à l'écriture (serveur, IA,
 * regroupement, cohérence) : tout bien rattaché existant du compte. Règle du
 * ticket § 3 : une pièce ou un équipement est refusé si son bien PORTEUR
 * n'est pas rattaché. La catégorie (« logement » = `isAgendaHousingAsset`) ne
 * décide que de l'AFFICHAGE des rubriques (tiroir, `agendaShowsRoomsAndEquipments`) :
 * un bien immobilier sans sous-type renseigné, ou une donnée ancienne, ne fait
 * donc jamais échouer un traitement automatique (intégration lot 103).
 */
export async function housingAssetIdsOf(r: GroupingRunner, accountId: number, assetIds: readonly number[]): Promise<number[]> {
  return [...new Set((await loadHousingAssetRefs(r, accountId, assetIds)).map((a) => a.id))];
}

/** Logements (catégorie) parmi des biens du compte — affichage des rubriques. */
export async function displayHousingAssetIdsOf(r: GroupingRunner, accountId: number, assetIds: readonly number[]): Promise<number[]> {
  return agendaHousingAssetIds(await loadHousingAssetRefs(r, accountId, assetIds));
}

/** Bien porteur de pièces et d'équipements (du compte). */
export async function loadStructuralParents(
  r: GroupingRunner, accountId: number, roomIds: readonly number[], equipmentIds: readonly number[],
): Promise<{ rooms: StructuralLinkRef[]; equipments: StructuralLinkRef[] }> {
  const rooms = roomIds.length ? await r.q<{ id: number; asset_id: number }>(
    `SELECT s.id, s.asset_id FROM substructures s JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 WHERE s.id = ANY($2::int[])`,
    [accountId, intArray(roomIds)]) : [];
  const equipments = equipmentIds.length ? await r.q<{ id: number; asset_id: number }>(
    `SELECT e.id, e.asset_id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE e.id = ANY($2::int[])`,
    [accountId, intArray(equipmentIds)]) : [];
  return {
    rooms: rooms.map((x) => ({ id: Number(x.id), assetId: Number(x.asset_id) })),
    equipments: equipments.map((x) => ({ id: Number(x.id), assetId: Number(x.asset_id) })),
  };
}

/** Biens rattachés à un élément d'agenda (liens directs, biens du compte). */
export async function agendaItemAssetIds(r: GroupingRunner, accountId: number, itemId: number): Promise<number[]> {
  const x = await r.q<{ asset_id: number }>(
    `SELECT l.asset_id FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
      WHERE l.agenda_item_id = $2 ORDER BY l.asset_id`, [accountId, itemId]);
  return x.map((y) => Number(y.asset_id));
}

/**
 * Biens qui déterminent les pièces / équipements d'un ENSEMBLE (regroupement) :
 * biens actifs de l'ensemble et biens de son événement de référence. Jamais
 * ceux des autres éléments seulement rattachés (règle « logement rattaché à
 * l'élément » : le tiroir qui porte les rubriques est celui de l'événement de
 * référence).
 */
export async function operationScopeAssetIds(r: GroupingRunner, accountId: number, operationId: number): Promise<number[]> {
  const x = await r.q<{ asset_id: number }>(
    `SELECT l.asset_id FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
      WHERE l.operation_id = $2 AND l.active
     UNION
     SELECT al.asset_id FROM agenda_items i
       JOIN agenda_asset_links al ON al.agenda_item_id = i.id
       JOIN assets a ON a.id = al.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
      WHERE i.account_id = $1 AND i.business_operation_id = $2 AND i.operation_role = 'PRINCIPAL'`, [accountId, operationId]);
  return [...new Set(x.map((y) => Number(y.asset_id)))].sort((a, b) => a - b);
}

/** Biens de l'ensemble qui autorisent ses pièces / équipements (écriture). */
export async function operationHousingAssetIds(r: GroupingRunner, accountId: number, operationId: number): Promise<number[]> {
  return housingAssetIdsOf(r, accountId, await operationScopeAssetIds(r, accountId, operationId));
}

/** Logements (catégorie) de l'ensemble — affichage des rubriques Pièces / Équipements. */
export async function operationDisplayHousingAssetIds(r: GroupingRunner, accountId: number, operationId: number): Promise<number[]> {
  return displayHousingAssetIdsOf(r, accountId, await operationScopeAssetIds(r, accountId, operationId));
}

/**
 * Pièces / équipements incompatibles avec les biens donnés (biens FINAUX de
 * l'élément après l'écriture envisagée).
 */
export async function planStructuralLinks(
  r: GroupingRunner, accountId: number,
  p: { assetIds: readonly number[]; substructureIds: readonly number[]; equipmentIds: readonly number[] },
): Promise<{ housingAssetIds: number[]; roomIds: number[]; equipmentIds: number[] }> {
  if (!p.substructureIds.length && !p.equipmentIds.length) return { housingAssetIds: [], roomIds: [], equipmentIds: [] };
  const housing = await housingAssetIdsOf(r, accountId, p.assetIds);
  const parents = await loadStructuralParents(r, accountId, p.substructureIds, p.equipmentIds);
  // Une référence introuvable dans le compte est traitée par SEC-07 (refus entier), pas ici.
  const ko = incompatibleStructuralLinks(housing, parents.rooms, parents.equipments);
  return { housingAssetIds: housing, ...ko };
}

/** Une pièce / un équipement peut-il être associé à cet élément (logement rattaché) ? */
export async function structuralLinkAllowedForItem(
  r: GroupingRunner, accountId: number, itemId: number, target: { substructureId?: number; equipmentId?: number },
): Promise<boolean> {
  const plan = await planStructuralLinks(r, accountId, {
    assetIds: await agendaItemAssetIds(r, accountId, itemId),
    substructureIds: target.substructureId ? [target.substructureId] : [],
    equipmentIds: target.equipmentId ? [target.equipmentId] : [],
  });
  return plan.roomIds.length === 0 && plan.equipmentIds.length === 0;
}

/** Journal structuré (sans donnée personnelle : identifiants et codes seulement). */
export function logStructuralLinkDecision(event: string, detail: Record<string, unknown>): void {
  console.info(JSON.stringify({ event: `agenda.structural_housing.${event}`, ...detail }));
}
