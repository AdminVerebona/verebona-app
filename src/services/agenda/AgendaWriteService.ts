/**
 * AgendaWriteService — create, update, delete agenda items
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, agendaFileLinks, agendaRoomLinks, agendaEquipmentLinks,
  assetFiles, substructures, equipments, assets,
} from '@/db/schema';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { validateTemporalConstraints, validateLinkCoherence, type ResolvedLink } from './AgendaDomainService';
import { getAgendaItemById, type AgendaItemFull } from './AgendaQueryService';
import { classifyAgendaItem } from './AgendaClassificationService';
import { emitAgendaItemCreated } from '@/services/coherence/impact-propagation.service';

export interface CreateAgendaItemInput {
  title: string;
  description?: string | null;
  startDate?: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
  manualStatus?: 'realise' | 'annule' | null;
  assetIds?: number[];
  fileIds?: number[];
  substructureIds?: number[];
  equipmentIds?: number[];
  originType?: string;
  originRefType?: string | null;
  originRefId?: number | null;
  originFieldKey?: string | null;
  isAutomatic?: boolean;
  requiresQualification?: boolean;
  /** Pre-classified home category from document analysis.
   * When provided, skips the AI classification call entirely. */
  homeCategory?: 'action' | 'information' | null;
}

export type UpdateAgendaItemInput = Partial<CreateAgendaItemInput>;

async function resolveIndirectLinks(
  fileIds: number[],
  substructureIds: number[],
  equipmentIds: number[]
): Promise<{ fileLinks: ResolvedLink[]; roomLinks: ResolvedLink[]; equipmentLinks: ResolvedLink[] }> {
  const [files, rooms, equips] = await Promise.all([
    fileIds.length > 0
      ? db.select({ id: assetFiles.id, assetId: assetFiles.assetId }).from(assetFiles).where(inArray(assetFiles.id, fileIds))
      : [],
    substructureIds.length > 0
      ? db.select({ id: substructures.id, assetId: substructures.assetId }).from(substructures).where(inArray(substructures.id, substructureIds))
      : [],
    equipmentIds.length > 0
      ? db.select({ id: equipments.id, assetId: equipments.assetId }).from(equipments).where(inArray(equipments.id, equipmentIds))
      : [],
  ]);

  return {
    fileLinks: files.map(f => ({ id: f.id, resolvedAssetId: f.assetId ?? null })),
    roomLinks: rooms.map(r => ({ id: r.id, resolvedAssetId: r.assetId })),
    equipmentLinks: equips.map(e => ({ id: e.id, resolvedAssetId: e.assetId })),
  };
}

 
export async function updateAgendaLinks(
  tx: any,
  agendaItemId: number,
  assetIds: number[],
  fileIds: number[],
  substructureIds: number[],
  equipmentIds: number[]
): Promise<void> {
  // Delete all existing links
  await Promise.all([
    tx.delete(agendaAssetLinks).where(eq(agendaAssetLinks.agendaItemId, agendaItemId)),
    tx.delete(agendaFileLinks).where(eq(agendaFileLinks.agendaItemId, agendaItemId)),
    tx.delete(agendaRoomLinks).where(eq(agendaRoomLinks.agendaItemId, agendaItemId)),
    tx.delete(agendaEquipmentLinks).where(eq(agendaEquipmentLinks.agendaItemId, agendaItemId)),
  ]);

  // Insert new links
  if (assetIds.length > 0) {
    await tx.insert(agendaAssetLinks).values(assetIds.map(id => ({ agendaItemId, assetId: id }))).onConflictDoNothing();
  }
  if (fileIds.length > 0) {
    await tx.insert(agendaFileLinks).values(fileIds.map(id => ({ agendaItemId, assetFileId: id }))).onConflictDoNothing();
  }
  if (substructureIds.length > 0) {
    await tx.insert(agendaRoomLinks).values(substructureIds.map(id => ({ agendaItemId, substructureId: id }))).onConflictDoNothing();
  }
  if (equipmentIds.length > 0) {
    await tx.insert(agendaEquipmentLinks).values(equipmentIds.map(id => ({ agendaItemId, equipmentId: id }))).onConflictDoNothing();
  }
}

/**
 * If an agenda item title contains "achat", sync its startDate to purchase_date
 * on all linked assets that don't yet have a purchase_date.
 */
async function syncPurchaseDateFromAgenda(
  agendaItemId: number,
  title: string,
  startDate: string | null | undefined,
  manualStatus?: string | null
): Promise<void> {
  if (!title || !startDate) return;
  if (!title.toLowerCase().includes('achat')) return;
  // Only sync when item is marked réalisé or has no explicit status yet (newly created)
  if (manualStatus !== undefined && manualStatus !== 'realise' && manualStatus !== null) return;

  // Find linked asset IDs
  const links = await db.select({ assetId: agendaAssetLinks.assetId })
    .from(agendaAssetLinks)
    .where(eq(agendaAssetLinks.agendaItemId, agendaItemId));

  if (links.length === 0) return;

  const assetIds = links.map(l => l.assetId);
  // Update purchase_date only on assets that don't have one yet
  for (const assetId of assetIds) {
    await db.update(assets)
      .set({ purchaseDate: startDate })
      .where(and(eq(assets.id, assetId), isNull(assets.purchaseDate)));
  }
}

export async function createAgendaItem(
  input: CreateAgendaItemInput,
  accountId: number,
  createdByUserId: number | null
): Promise<AgendaItemFull> {
  // 1. Validate temporal constraints
  const temporalErrors = validateTemporalConstraints({
    startDate: input.startDate,
    startTime: input.startTime,
    endDate: input.endDate,
    endTime: input.endTime,
  });
  if (temporalErrors.length > 0) {
    throw new Error(`Validation temporelle : ${temporalErrors.map(e => e.message).join(', ')}`);
  }

  // 2. Validate link coherence
  const assetIds = input.assetIds ?? [];
  const fileIds = input.fileIds ?? [];
  const substructureIds = input.substructureIds ?? [];
  const equipmentIds = input.equipmentIds ?? [];

  const { fileLinks, roomLinks, equipmentLinks } = await resolveIndirectLinks(fileIds, substructureIds, equipmentIds);
  const linkErrors = validateLinkCoherence(assetIds, fileLinks, roomLinks, equipmentLinks);
  if (linkErrors.length > 0) {
    throw new Error(`Cohérence des liens : ${linkErrors.map(e => e.message).join(', ')}`);
  }

  // 3. Classify for home page (async, non-blocking for the transaction)
  const homeCategoryResult = input.homeCategory ?? await classifyAgendaItem(
    input.title,
    input.description,
    input.originType ?? 'manual',
    input.originFieldKey,
  );

  // 4. Transaction: INSERT item + links
  const result = await db.transaction(async tx => {
    const [inserted] = await tx.insert(agendaItems).values({
      accountId,
      createdByUserId,
      title: input.title,
      description: input.description ?? null,
      startDate: input.startDate ?? null,
      startTime: input.startTime ?? null,
      endDate: input.endDate ?? null,
      endTime: input.endTime ?? null,
      manualStatus: input.manualStatus ?? null,
      isAutomatic: input.isAutomatic ?? false,
      isAutomaticModified: false,
      requiresQualification: input.requiresQualification ?? false,
      originType: input.originType ?? 'manual',
      originRefType: input.originRefType ?? null,
      originRefId: input.originRefId ?? null,
      originFieldKey: input.originFieldKey ?? null,
      homeCategory: homeCategoryResult,
    }).returning();

    await updateAgendaLinks(tx, inserted.id, assetIds, fileIds, substructureIds, equipmentIds);
    return inserted;
  });

  const full = await getAgendaItemById(result.id, accountId);
  if (!full) throw new Error('Item created but not found');

  // Sync purchase_date on linked assets if this is an "achat" item
  await syncPurchaseDateFromAgenda(result.id, input.title, input.startDate ?? null);

  // Déclencher la propagation d'impact pour les biens liés
  const linkAssetIds = input.assetIds ?? [];
  for (const aid of linkAssetIds) {
    emitAgendaItemCreated(accountId, aid, result.id).catch(() => {});
  }

  return full;
}

export async function updateAgendaItem(
  id: number,
  input: UpdateAgendaItemInput,
  accountId: number
): Promise<AgendaItemFull> {
  const existing = await getAgendaItemById(id, accountId);
  if (!existing) throw new Error('Item not found');

  const temporalErrors = validateTemporalConstraints({
    startDate: input.startDate ?? existing.startDate,
    startTime: input.startTime ?? existing.startTime,
    endDate: input.endDate ?? existing.endDate,
    endTime: input.endTime ?? existing.endTime,
  });
  if (temporalErrors.length > 0) {
    throw new Error(`Validation temporelle : ${temporalErrors.map(e => e.message).join(', ')}`);
  }

  const assetIds = input.assetIds ?? existing.assetLinks.map(l => l.assetId);
  const fileIds = input.fileIds ?? existing.fileLinks.map(l => l.assetFileId);
  const substructureIds = input.substructureIds ?? existing.roomLinks.map(l => l.substructureId);
  const equipmentIds = input.equipmentIds ?? existing.equipmentLinks.map(l => l.equipmentId);

  const { fileLinks, roomLinks, equipmentLinks } = await resolveIndirectLinks(fileIds, substructureIds, equipmentIds);
  const linkErrors = validateLinkCoherence(assetIds, fileLinks, roomLinks, equipmentLinks);
  if (linkErrors.length > 0) {
    throw new Error(`Cohérence des liens : ${linkErrors.map(e => e.message).join(', ')}`);
  }

  // Detect if automatic item has been manually modified
  const isAutomaticModified = existing.isAutomatic &&
    (input.title !== undefined || input.description !== undefined ||
     input.startDate !== undefined || input.startTime !== undefined ||
     input.endDate !== undefined || input.endTime !== undefined);

  await db.transaction(async tx => {
    await tx.update(agendaItems).set({
      title: input.title ?? existing.title,
      description: input.description !== undefined ? input.description : existing.description,
      startDate: input.startDate !== undefined ? input.startDate : existing.startDate,
      startTime: input.startTime !== undefined ? input.startTime : existing.startTime,
      endDate: input.endDate !== undefined ? input.endDate : existing.endDate,
      endTime: input.endTime !== undefined ? input.endTime : existing.endTime,
      isAutomaticModified: existing.isAutomaticModified || isAutomaticModified,
      // Check if title was the temp qualification title and is now replaced
      requiresQualification: checkQualification(
        existing,
        input.title ?? existing.title
      ),
      updatedAt: new Date(),
    }).where(and(eq(agendaItems.id, id), eq(agendaItems.accountId, accountId)));

    await updateAgendaLinks(tx, id, assetIds, fileIds, substructureIds, equipmentIds);
  });

  const full = await getAgendaItemById(id, accountId);
  if (!full) throw new Error('Item not found after update');

  await syncPurchaseDateFromAgenda(id, full.title, full.startDate);

  return full;
}

/**
 * MVP qualification rule: a distinct item is considered qualified when
 * the user replaces the system-generated temporary title with an explicit title.
 */
function checkQualification(existing: AgendaItemFull, newTitle: string): boolean {
  if (!existing.requiresQualification) return false;
  const TEMP_TITLE = 'Nouvelle donnée à qualifier';
  // If it was requiring qualification and the title has been changed away from temp, qualify it
  if (existing.title === TEMP_TITLE && newTitle !== TEMP_TITLE) return false;
  return true;
}

export async function updateManualStatus(
  id: number,
  manualStatus: 'realise' | 'annule' | null,
  accountId: number
): Promise<AgendaItemFull> {
  await db.update(agendaItems).set({
    manualStatus,
    updatedAt: new Date(),
  }).where(and(eq(agendaItems.id, id), eq(agendaItems.accountId, accountId)));

  const full = await getAgendaItemById(id, accountId);
  if (!full) throw new Error('Item not found');

  // Sync purchase_date when marked réalisé
  if (manualStatus === 'realise') {
    await syncPurchaseDateFromAgenda(id, full.title, full.startDate, manualStatus);
  }

  return full;
}

export async function deleteAgendaItem(id: number, accountId: number): Promise<void> {
  const existing = await getAgendaItemById(id, accountId);
  if (!existing) throw new Error('Item not found');
  await db.delete(agendaItems).where(and(eq(agendaItems.id, id), eq(agendaItems.accountId, accountId)));
}
