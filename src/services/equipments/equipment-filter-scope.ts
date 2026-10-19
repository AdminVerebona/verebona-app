/**
 * Filtre « Équipement » — lectures serveur communes à « Mes documents » et
 * à « Mon agenda ». Lot 71 (71C).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI FAIT D'UN ÉLÉMENT UN « ÉLÉMENT D'ÉQUIPEMENT »
 *
 * Uniquement une association PERSISTÉE en base — jamais le nom :
 *
 *   · document  : colonne historique `asset_files.equipment_id`, OU lien N-N
 *                 ACTIF `document_asset_links.equipment_id` de rôle PRIMARY
 *                 ou SECONDARY (même règle que la liste d'un bien, lot 32C :
 *                 un équipement seulement CITÉ — MENTIONED — n'en fait pas
 *                 partie). Le déclencheur 0221 reflète la colonne en lien
 *                 LEGACY_COLUMN ; les deux sont lus pour ne dépendre ni de
 *                 l'un ni de l'autre (rattrapage en cours, lot 71A).
 *   · événement : `agenda_equipment_links`.
 *
 * Les équipements proposés sont ceux des biens sélectionnés, bornés au
 * compte (bien du compte, non supprimé) : un identifiant d'équipement venu
 * de l'URL et étranger à ces biens ne filtre jamais sur un autre compte —
 * il ne rend rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles, assets, equipments } from '@/db/schema';
import { ASSET_LIST_LINK_ROLES_SQL } from '@/services/documents/asset-document-scope';
import {
  EQUIPMENT_FILTER_ALL,
  EQUIPMENT_FILTER_ASSET_ONLY,
  EQUIPMENT_FILTER_MAX_OPTIONS,
  parseEquipmentFilter,
  type EquipmentFilterValue,
} from '@/lib/filters/equipment-filter';

export interface AssetEquipment {
  id: number;
  name: string;
  assetId: number;
  assetName: string;
  archived: boolean;
}

/** Biens retenus pour le filtre : identifiants positifs, uniques, bornés à 100. */
export function equipmentScopeAssetIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
}

/**
 * Équipements des biens (du compte, non supprimés), triés par bien puis nom.
 * Une requête, bornée à `EQUIPMENT_FILTER_MAX_OPTIONS` lignes.
 */
export async function listEquipmentsOfAssets(accountId: number, assetIds: readonly number[]): Promise<AssetEquipment[]> {
  const ids = equipmentScopeAssetIds(assetIds);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: equipments.id,
      name: equipments.name,
      assetId: equipments.assetId,
      assetName: assets.name,
      archivedAt: equipments.archivedAt,
    })
    .from(equipments)
    .innerJoin(assets, and(eq(assets.id, equipments.assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)))
    .where(inArray(equipments.assetId, ids))
    .orderBy(asc(assets.name), asc(equipments.name), asc(equipments.id))
    .limit(EQUIPMENT_FILTER_MAX_OPTIONS);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    assetId: r.assetId,
    assetName: r.assetName ?? '',
    archived: r.archivedAt !== null,
  }));
}

/** Condition Drizzle (table `asset_files` non aliasée) : document associé à l'un de ces équipements. */
export function documentOfEquipmentsCondition(equipmentIds: readonly number[]): SQL {
  const ids = [...new Set(equipmentIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return sql`FALSE`;
  const liste = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  // COALESCE : `NULL IN (…)` vaut NULL, et `NOT NULL` écarterait à tort tous
  // les documents sans équipement du filtre « Bien uniquement ».
  return sql`(COALESCE(${assetFiles.equipmentId} IN (${liste}), FALSE)
    OR ${assetFiles.id} IN (SELECT dal.file_id FROM document_asset_links dal
                            WHERE dal.equipment_id IN (${liste}) AND dal.status = 'ACTIVE'
                              AND dal.link_role IN ${sql.raw(ASSET_LIST_LINK_ROLES_SQL)}))`;
}

/**
 * Condition du filtre Équipement sur les documents, ou `null` (aucun effet).
 *
 *   · `all`, ou biens sans équipement : `null` ;
 *   · `asset` : document associé à AUCUN équipement de ces biens ;
 *   · `<id>`  : document associé à CET équipement — `FALSE` s'il n'est pas
 *     un équipement des biens retenus (lien abîmé, autre compte).
 */
export function documentEquipmentFilterCondition(
  value: EquipmentFilterValue | null | undefined,
  assetEquipments: readonly Pick<AssetEquipment, 'id'>[],
): SQL | null {
  const v = parseEquipmentFilter(value);
  if (v === EQUIPMENT_FILTER_ALL || assetEquipments.length === 0) return null;
  const ids = assetEquipments.map((e) => e.id);
  if (v === EQUIPMENT_FILTER_ASSET_ONLY) return sql`NOT ${documentOfEquipmentsCondition(ids)}`;
  const id = Number(v);
  return ids.includes(id) ? documentOfEquipmentsCondition([id]) : sql`FALSE`;
}

/**
 * Filtre Équipement sur des événements déjà chargés (liens `equipmentLinks`
 * relus et bornés au compte par `AgendaQueryService`). Pur.
 *
 * Aucun équipement dans les biens retenus : la liste est rendue telle quelle.
 */
export function filterItemsByEquipment<T extends { equipmentLinks: Array<{ equipmentId: number }> }>(
  items: readonly T[],
  value: EquipmentFilterValue | null | undefined,
  assetEquipmentIds: readonly number[],
): T[] {
  const v = parseEquipmentFilter(value);
  if (v === EQUIPMENT_FILTER_ALL || assetEquipmentIds.length === 0) return [...items];
  const ids = new Set(assetEquipmentIds);
  if (v === EQUIPMENT_FILTER_ASSET_ONLY) {
    return items.filter((i) => !i.equipmentLinks.some((l) => ids.has(l.equipmentId)));
  }
  const id = Number(v);
  if (!ids.has(id)) return [];
  return items.filter((i) => i.equipmentLinks.some((l) => l.equipmentId === id));
}

/** Compteurs du filtre sur des événements chargés (avant filtre Équipement). Pur. */
export function countItemsByEquipment<T extends { equipmentLinks: Array<{ equipmentId: number }> }>(
  items: readonly T[],
  assetEquipmentIds: readonly number[],
): { all: number; assetOnly: number; byEquipment: Map<number, number> } {
  const ids = new Set(assetEquipmentIds);
  const byEquipment = new Map<number, number>(assetEquipmentIds.map((id) => [id, 0]));
  let assetOnly = 0;
  for (const item of items) {
    const linked = new Set(item.equipmentLinks.map((l) => l.equipmentId).filter((id) => ids.has(id)));
    if (linked.size === 0) assetOnly += 1;
    for (const id of linked) byEquipment.set(id, (byEquipment.get(id) ?? 0) + 1);
  }
  return { all: items.length, assetOnly, byEquipment };
}
