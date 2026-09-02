/**
 * AgendaWriteService — create, update, delete agenda items
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, agendaFileLinks, agendaRoomLinks, agendaEquipmentLinks,
  agendaDataConflicts, agendaItemSources, energyWorks, impactQueue,
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

/**
 * Exécute un détachement de traçabilité sans pouvoir compromettre la
 * transaction englobante.
 *
 * `tx.transaction()` pose un SAVEPOINT : en cas d'échec, seul le bloc est
 * annulé, la transaction extérieure reste utilisable. Sans cela, la moindre
 * erreur — table absente, colonne renommée — abandonnerait toute la
 * suppression, alors que ces détachements sont accessoires : la table de
 * traçabilité tolère un lien nul, c'est sa définition même.
 */
async function detachSafely(
  tx: any,
  libelle: string,
  run: (t: any) => Promise<unknown>,
): Promise<void> {
  try {
    await tx.transaction(async (inner: any) => { await run(inner); });
  } catch (e) {
    console.warn(
      `[agenda] détachement ignoré (${libelle}) :`,
      (e as Error).message,
    );
  }
}

/**
 * Suppression d'un élément d'agenda.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ LES LIGNES FILLES SONT SUPPRIMÉES ICI, PAS PAR LA BASE
 *
 * La version précédente se contentait d'un `DELETE FROM agenda_items` et
 * s'en remettait entièrement au `ON DELETE CASCADE` des quatre tables de
 * liaison et au `ON DELETE SET NULL` des cinq colonnes qui référencent un
 * élément d'agenda.
 *
 * Ces actions référentielles sont déclarées dans `0050_agenda_items.sql`
 * — en `CREATE TABLE IF NOT EXISTS`. Sur une base où ces tables
 * préexistaient (`agenda_item_sources` et `impact_queue` ne sont créées par
 * AUCUNE migration : elles viennent d'un `drizzle-kit push`), la migration
 * passe en silence et les clés étrangères restent en `NO ACTION`.
 *
 * Conséquence observée : tout élément rattaché à un bien — c'est-à-dire la
 * quasi-totalité — remontait une violation de contrainte, traduite en 500
 * puis en « Erreur lors de la suppression ». Seuls les éléments sans
 * aucune liaison se supprimaient.
 *
 * Le détachement explicite ci-dessous produit le même résultat que les
 * cascades, que celles-ci soient correctement posées ou non. La migration
 * `0126_fix_agenda_delete_fk.sql` répare les contraintes pour l'avenir ;
 * ce code ne dépend plus d'elle.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function deleteAgendaItem(id: number, accountId: number): Promise<void> {
  const existing = await getAgendaItemById(id, accountId);
  if (!existing) throw new Error('Item not found');

  await db.transaction(async tx => {
    // 1. Liaisons — elles n'ont pas d'existence propre, elles disparaissent.
    await tx.delete(agendaAssetLinks).where(eq(agendaAssetLinks.agendaItemId, id));
    await tx.delete(agendaFileLinks).where(eq(agendaFileLinks.agendaItemId, id));
    await tx.delete(agendaRoomLinks).where(eq(agendaRoomLinks.agendaItemId, id));
    await tx.delete(agendaEquipmentLinks).where(eq(agendaEquipmentLinks.agendaItemId, id));

    // 2. Références conservées — la trace reste, le lien est détaché.
    //    Un conflit résolu, une source d'analyse ou un travail énergétique
    //    documentent une décision passée : les supprimer effacerait
    //    l'historique exigé par le §4.4.4.
    //
    //    Chaque détachement est isolé par un point de sauvegarde. Deux de ces
    //    tables (`agenda_item_sources`, `impact_queue`) ne sont créées par
    //    aucune migration : sur une base où le `push` n'est pas passé, elles
    //    peuvent manquer. Sans isolation, l'absence d'une table de traçabilité
    //    rendrait de nouveau la suppression impossible — soit exactement le
    //    défaut que ce correctif traite.
    await detachSafely(tx, 'agenda_data_conflicts.agenda_item_id', t =>
      t.update(agendaDataConflicts)
        .set({ agendaItemId: null })
        .where(eq(agendaDataConflicts.agendaItemId, id)));
    await detachSafely(tx, 'agenda_data_conflicts.result_agenda_item_id', t =>
      t.update(agendaDataConflicts)
        .set({ resultAgendaItemId: null })
        .where(eq(agendaDataConflicts.resultAgendaItemId, id)));
    await detachSafely(tx, 'agenda_item_sources', t =>
      t.update(agendaItemSources)
        .set({ agendaItemId: null })
        .where(eq(agendaItemSources.agendaItemId, id)));
    await detachSafely(tx, 'energy_works', t =>
      t.update(energyWorks)
        .set({ agendaItemId: null })
        .where(eq(energyWorks.agendaItemId, id)));
    await detachSafely(tx, 'impact_queue', t =>
      t.update(impactQueue)
        .set({ agendaItemId: null })
        .where(eq(impactQueue.agendaItemId, id)));

    // 3. L'élément lui-même. Le filtre sur le compte est conservé : il est
    //    la garantie d'isolation, pas une simple redondance avec la lecture
    //    de contrôle ci-dessus.
    await tx.delete(agendaItems)
      .where(and(eq(agendaItems.id, id), eq(agendaItems.accountId, accountId)));
  });
}
