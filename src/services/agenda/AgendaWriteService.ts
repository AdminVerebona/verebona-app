/**
 * AgendaWriteService — create, update, delete agenda items.
 *
 * CDC 15 T4-09 (lot 14) : création et modification passent par la primitive
 * commune `upsertAgendaItem` (validations, liens, liens source, nature,
 * recopie « achat » D-13, notification D-14, statut du bien D-15), partagée
 * avec T4 (`agenda-persistence`). Tous modes : comportement historique à
 * l'identique en legacy et shadow (tests de parité).
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, agendaFileLinks, agendaRoomLinks, agendaEquipmentLinks,
  agendaDataConflicts, agendaItemSources, energyWorks, impactQueue,
} from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getAgendaItemById, type AgendaItemFull } from './AgendaQueryService';
import { classifyAgendaItem } from './AgendaClassificationService';
import { isEnabled } from '@/services/ai/flags/ai-feature-flags';
import { t4EffectsMode } from '@/services/canonical/rollout';
import {
  writeAgendaLinks, validateAgendaWrite, syncPurchaseDate, type AgendaItemValues,
} from './write-agenda-item';
import { upsertAgendaItem, agendaItemValues, type AgendaUpsertInput } from './agenda-write-primitive';

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

/**
 * Liaisons d'un élément (état complet). Conservé pour compatibilité ; la
 * primitive `writeAgendaItem` porte désormais l'écriture (CDC 15 T4-09).
 */
export async function updateAgendaLinks(
  tx: any,
  agendaItemId: number,
  assetIds: number[],
  fileIds: number[],
  substructureIds: number[],
  equipmentIds: number[]
): Promise<void> {
  await writeAgendaLinks(tx, agendaItemId, { assetIds, fileIds, substructureIds, equipmentIds }, 'replace');
}

export async function createAgendaItem(
  input: CreateAgendaItemInput,
  accountId: number,
  createdByUserId: number | null
): Promise<AgendaItemFull> {
  // 1-2. Contrôles de dates et de cohérence des liens — AVANT la
  // classification : une demande invalide ne coûte aucun appel modèle.
  const assetIds = input.assetIds ?? [];
  const fileIds = input.fileIds ?? [];
  const substructureIds = input.substructureIds ?? [];
  const equipmentIds = input.equipmentIds ?? [];
  await validateAgendaWrite(
    { startDate: input.startDate, startTime: input.startTime, endDate: input.endDate, endTime: input.endTime },
    { assetIds, fileIds, substructureIds, equipmentIds },
  );

  // 3. Classify for home page (async, non-blocking for the transaction)
  //
  // ── AIGUILLAGE DE BASCULE (CDC §10.4) ────────────────────────────────────
  // Ce chemin ignorait `AI_AGENDA_ENGINE` : quelle que soit sa valeur, c'est
  // l'ancien `AgendaClassificationService` qui classait toute échéance créée à
  // la main, y compris quand le nouveau moteur était censé l'avoir remplacé.
  // Le drapeau ne commandait donc rien sur la moitié du trafic agenda.
  //
  // `isEnabled` et non `shouldRunNewEngine` : en mode observation, faire
  // classer le même événement par les DEUX moteurs doublerait l'appel modèle
  // pour une valeur dont une seule serait retenue. L'ancien reste seul tant
  // que la bascule n'est pas franche.
  const homeCategoryResult = input.homeCategory ?? (
    isEnabled('AI_AGENDA_ENGINE')
      // Import dynamique : le chemin historique ne doit pas charger l'usage 4
      // tant qu'il n'est pas basculé, comme le pont inverse dans `events.ts`.
      ? await (async () => {
          const { classifyAgendaCategory } = await import('@/services/ai/agenda');
          return classifyAgendaCategory(
            {
              title: input.title,
              description: input.description,
              originType: input.originType ?? 'manual',
              originFieldKey: input.originFieldKey,
            },
            { accountId, userId: createdByUserId ?? undefined },
          );
        })()
      : await classifyAgendaItem(
          input.title,
          input.description,
          input.originType ?? 'manual',
          input.originFieldKey,
          { accountId, userId: createdByUserId ?? undefined },
        )
  );

  // 4. Primitive commune (CDC 15 T4-09) : ligne + liens en une transaction,
  // liens source (pièces jointes, enabled), recopie « achat » (D-13) et
  // notification des biens liés (D-14).
  const written = await upsertAgendaItem(
    manualUpsertInput(input, accountId, createdByUserId, homeCategoryResult),
    { actorUserId: createdByUserId, validate: false, notify: true, purchaseSync: {} },
  );

  const full = await getAgendaItemById(written.id, accountId);
  if (!full) throw new Error('Item created but not found');
  return full;
}

/** Entrée de la primitive pour un élément créé à la main. */
export function manualUpsertInput(
  input: CreateAgendaItemInput,
  accountId: number,
  createdByUserId: number | null,
  homeCategory: 'action' | 'information' | null,
): AgendaUpsertInput {
  const assetIds = input.assetIds ?? [];
  const fileIds = input.fileIds ?? [];
  return {
    accountId,
    assetId: assetIds[0] ?? null,
    origin: 'MANUAL',
    category: homeCategory,
    date: input.startDate ?? null,
    title: input.title,
    originFieldKey: input.originFieldKey ?? null,
    sources: fileIds.map((fileId) => ({ fileId, role: 'ATTACHMENT' as const })),
    links: { assetIds, fileIds, substructureIds: input.substructureIds ?? [], equipmentIds: input.equipmentIds ?? [] },
    details: {
      createdByUserId,
      description: input.description ?? null,
      startTime: input.startTime ?? null,
      endDate: input.endDate ?? null,
      endTime: input.endTime ?? null,
      manualStatus: input.manualStatus ?? null,
      requiresQualification: input.requiresQualification ?? false,
      isAutomatic: input.isAutomatic ?? false,
      originType: input.originType ?? 'manual',
      originRefType: input.originRefType ?? null,
      originRefId: input.originRefId ?? null,
    },
  };
}

/** Valeurs d'un élément créé à la main — identiques à l'historique (parité). */
export function manualInsertValues(
  input: CreateAgendaItemInput,
  createdByUserId: number | null,
  homeCategory: 'action' | 'information' | null,
): AgendaItemValues {
  return agendaItemValues(manualUpsertInput(input, 0, createdByUserId, homeCategory)) as AgendaItemValues;
}

export async function updateAgendaItem(
  id: number,
  input: UpdateAgendaItemInput,
  accountId: number
): Promise<AgendaItemFull> {
  const existing = await getAgendaItemById(id, accountId);
  if (!existing) throw new Error('Item not found');

  const assetIds = input.assetIds ?? existing.assetLinks.map(l => l.assetId);
  const fileIds = input.fileIds ?? existing.fileLinks.map(l => l.assetFileId);
  const substructureIds = input.substructureIds ?? existing.roomLinks.map(l => l.substructureId);
  const equipmentIds = input.equipmentIds ?? existing.equipmentLinks.map(l => l.equipmentId);

  await validateAgendaWrite({
    startDate: input.startDate ?? existing.startDate,
    startTime: input.startTime ?? existing.startTime,
    endDate: input.endDate ?? existing.endDate,
    endTime: input.endTime ?? existing.endTime,
  }, { assetIds, fileIds, substructureIds, equipmentIds });

  // Detect if automatic item has been manually modified
  const isAutomaticModified = existing.isAutomatic &&
    (input.title !== undefined || input.description !== undefined ||
     input.startDate !== undefined || input.startTime !== undefined ||
     input.endDate !== undefined || input.endTime !== undefined);

  // Occurrence PRÉVISIONNELLE dont l'utilisateur fixe la date : sa valeur est
  // protégée (isAutomaticModified) et l'occurrence devient confirmée par
  // l'utilisateur — la date estimée d'origine reste traçable.
  const confirmeParUtilisateur = existing.occurrenceNature === 'FORECAST'
    && input.startDate !== undefined && input.startDate !== null;

  // Primitive commune (CDC 15 T4-09) : même transaction ligne + liens.
  await upsertAgendaItem({
    itemId: id,
    accountId,
    assetId: assetIds[0] ?? null,
    origin: 'MANUAL',
    title: input.title ?? existing.title,
    date: input.startDate !== undefined ? input.startDate : existing.startDate,
    links: { assetIds, fileIds, substructureIds, equipmentIds },
    sources: fileIds.map((fileId) => ({ fileId, role: 'ATTACHMENT' as const })),
    details: {
      description: input.description !== undefined ? input.description : existing.description,
      startTime: input.startTime !== undefined ? input.startTime : existing.startTime,
      endDate: input.endDate !== undefined ? input.endDate : existing.endDate,
      endTime: input.endTime !== undefined ? input.endTime : existing.endTime,
      isAutomaticModified: existing.isAutomaticModified || isAutomaticModified,
      // Check if title was the temp qualification title and is now replaced
      requiresQualification: checkQualification(existing, input.title ?? existing.title),
      extra: confirmeParUtilisateur ? {
        occurrenceNature: 'CONFIRMED',
        dateSource: 'USER',
        forecastInitialDate: existing.forecastInitialDate ?? existing.startDate,
        confirmedAt: new Date(),
        confirmationMode: 'USER',
      } : {},
    },
  }, { linkMode: 'replace', validate: false });

  if (isAutomaticModified || confirmeParUtilisateur) {
    const { recordOccurrenceEvent } = await import('./agenda-persistence');
    await recordOccurrenceEvent(id, accountId, confirmeParUtilisateur ? 'USER_CONFIRMED' : 'USER_MODIFIED', {
      before: { title: existing.title, date: existing.startDate, nature: existing.occurrenceNature },
      after: { title: input.title ?? existing.title, date: input.startDate ?? existing.startDate },
    }, null);
  }

  // Recopie « achat » (historique : à chaque édition ; enabled : D-13).
  await syncPurchaseDate({ itemId: id, accountId, actorUserId: null, mode: t4EffectsMode() });

  const full = await getAgendaItemById(id, accountId);
  if (!full) throw new Error('Item not found after update');

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

  // Réalisée / annulée : l'état change, la NATURE (prévisionnelle ou
  // confirmée) est conservée.
  const { recordOccurrenceEvent } = await import('./agenda-persistence');
  await recordOccurrenceEvent(id, accountId, 'STATUS_CHANGED', { manualStatus, nature: full.occurrenceNature });

  // Statut posé par l'utilisateur : les cartes « réalisée ? » / « non
  // réalisée ? » de l'élément sont sans objet (T4-12, lot 14). Elles
  // n'existent que sous AI_T4_EFFECTS=enabled ou T4 master.
  if (manualStatus) {
    const { closeAgendaStatusCards } = await import('@/services/to-process/agenda-status-cards');
    await closeAgendaStatusCards(accountId, id, 'USER_COMPLETED')
      .catch((e: Error) => console.error('[agenda] fermeture des cartes de statut :', e.message));
  }

  // Recopie « achat » quand l'élément est marqué réalisé (D-13 en enabled).
  if (manualStatus === 'realise') {
    await syncPurchaseDate({ itemId: id, accountId, actorUserId: null, mode: t4EffectsMode(), manualStatus });
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

/**
 * L'utilisateur confirme explicitement une occurrence prévisionnelle, telle
 * quelle : elle devient CONFIRMED (mode USER), sa date est protégée.
 */
export async function confirmForecastOccurrence(
  id: number,
  accountId: number,
  userId: number | null,
): Promise<AgendaItemFull> {
  const existing = await getAgendaItemById(id, accountId);
  if (!existing) throw new Error('Item not found');
  if (existing.occurrenceNature !== 'FORECAST') return existing;
  const now = new Date();
  await db.update(agendaItems).set({
    occurrenceNature: 'CONFIRMED',
    dateSource: 'USER',
    forecastInitialDate: existing.forecastInitialDate ?? existing.startDate,
    confirmedAt: now,
    confirmationMode: 'USER',
    isAutomaticModified: existing.isAutomatic ? true : existing.isAutomaticModified,
    updatedAt: now,
  }).where(and(eq(agendaItems.id, id), eq(agendaItems.accountId, accountId)));
  const { recordOccurrenceEvent } = await import('./agenda-persistence');
  await recordOccurrenceEvent(id, accountId, 'USER_CONFIRMED', { date: existing.startDate }, userId);
  const full = await getAgendaItemById(id, accountId);
  if (!full) throw new Error('Item not found after update');
  return full;
}
