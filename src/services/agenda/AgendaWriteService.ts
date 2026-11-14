/**
 * AgendaWriteService — create, update, delete agenda items.
 *
 * CDC 15 T4-09 (lot 14) : création et modification passent par la primitive
 * commune `upsertAgendaItem` (validations, liens, liens source, nature,
 * recopie « achat » D-13, notification D-14, statut du bien D-15), partagée
 * avec T4 (`agenda-persistence`).
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, agendaFileLinks, agendaRoomLinks, agendaEquipmentLinks,
  agendaDataConflicts, agendaItemSources, energyWorks, impactQueue,
} from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getAgendaItemById, type AgendaItemFull } from './AgendaQueryService';
import { validateAgendaWrite, syncPurchaseDate, AgendaValidationError, AgendaStructuralLinkError, type AgendaItemValues,
} from './write-agenda-item';
import { drizzleRunner } from '@/services/business-operations/grouping/runner';
import { logStructuralLinkDecision, planStructuralLinks } from './housing-scope.service';
import { upsertAgendaItem, agendaItemValues, type AgendaUpsertInput } from './agenda-write-primitive';
import { resolveNoDeadlineWrite } from '@/lib/agenda/no-deadline';
import { resolveSituationWrite, situationOf, type AgendaSituation, type AgendaSituationSource } from '@/lib/agenda/situation';
import { todayParisDateStr } from '@/lib/notifications/time-paris';
import type { AgendaDeletionScope } from './agenda-user-deletion';

interface CreateAgendaItemInput {
  title: string;
  description?: string | null;
  startDate?: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
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
  /**
   * Lot 77A : option « Sans échéance » — geste de l'UTILISATEUR (tiroirs de
   * création / modification, desktop et mobile). Validée par
   * `resolveNoDeadlineWrite` : incompatible avec une date. Jamais transmise
   * par un traitement automatique.
   */
  noDeadline?: boolean;
  /**
   * Lot 114V (#742) : « Situation de l'événement » (`A_EU_LIEU` | `A_PREVOIR`)
   * — choix de l'UTILISATEUR (sélecteur des tiroirs, carte « À traiter » de
   * qualification). Validée par `resolveSituationWrite` : absente d'une
   * création manuelle → « À prévoir » (défaut serveur) ; « A eu lieu » avec
   * une date future → refus explicite. Jamais transmise par un traitement.
   */
  situation?: AgendaSituation | null;
  /** Renseignée par le service (provenance) — jamais lue d'une demande. */
  situationSource?: AgendaSituationSource;
}

/** Horloge injectable (tests indépendants de la date du jour). */
interface AgendaWriteClock { today?: string }

type UpdateAgendaItemInput = Partial<CreateAgendaItemInput> & {
  /**
   * Lot 103D : l'utilisateur a CONFIRMÉ la dissociation des pièces /
   * équipements devenus incompatibles (logement retiré) — liens seulement,
   * dans la même écriture ; sans cette confirmation, refus
   * `AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS` et rien n'est écrit.
   */
  dissociateIncompatible?: boolean;
};

export async function createAgendaItem(
  input: CreateAgendaItemInput,
  accountId: number,
  createdByUserId: number | null,
  clock: AgendaWriteClock = {},
): Promise<AgendaItemFull> {
  // Lot 77A : « Sans échéance » validée d'abord (incompatible avec une date).
  const sansEcheance = resolveNoDeadlineWrite(input);
  if (!sansEcheance.ok) throw new AgendaValidationError(sansEcheance.error);
  if (sansEcheance.clearDates) input = { ...input, startDate: null, startTime: null, endDate: null, endTime: null };
  input = { ...input, noDeadline: sansEcheance.noDeadline === true };

  // Lot 114V (#742) : situation de l'événement — AVANT toute écriture et tout
  // appel modèle. Création MANUELLE par l'utilisateur sans situation transmise
  // (ancien client, Assistant) : « À prévoir ». Un élément créé par un
  // traitement par ce chemin (donnée à qualifier, origine non manuelle) reste
  // non qualifié.
  const situation = resolveSituationWrite({
    situation: input.situation,
    effectiveStartDate: input.startDate ?? null,
    requestedNoDeadline: input.noDeadline === true,
    defaultForManualCreation: (input.originType ?? 'manual') === 'manual' && !input.isAutomatic && !input.requiresQualification,
    coupleTouched: true,
    today: clock.today ?? todayParisDateStr(),
  });
  if (!situation.ok) throw new AgendaValidationError(situation.error);
  input = { ...input, situation: situation.situation ?? null, situationSource: situation.source };

  // 1-2. Contrôles de dates et de cohérence des liens — AVANT la
  // classification : une demande invalide ne coûte aucun appel modèle.
  const assetIds = input.assetIds ?? [];
  const fileIds = input.fileIds ?? [];
  const substructureIds = input.substructureIds ?? [];
  const equipmentIds = input.equipmentIds ?? [];
  // Lot 103D : pièces / équipements seulement pour un logement rattaché (code stable, refus avant tout appel
  // modèle). Seuls les objets DU COMPTE sont lus : une référence étrangère est refusée juste après (SEC-07).
  const plan = await planStructuralLinks(drizzleRunner(db), accountId, { assetIds, substructureIds, equipmentIds });
  if (plan.roomIds.length || plan.equipmentIds.length) {
    logStructuralLinkDecision('refused', { accountId, agendaItemId: null, roomIds: plan.roomIds, equipmentIds: plan.equipmentIds });
    throw new AgendaStructuralLinkError({ roomIds: plan.roomIds, equipmentIds: plan.equipmentIds });
  }
  // Lot 49 (SEC-07) : appartenance au compte contrôlée d'abord (la
  // primitive la recontrôle dans sa transaction).
  await validateAgendaWrite(
    { startDate: input.startDate, startTime: input.startTime, endDate: input.endDate, endTime: input.endTime },
    { assetIds, fileIds, substructureIds, equipmentIds },
    accountId,
  );

  // 3. Catégorie de l'accueil (action / information) : mêmes règles
  // déterministes et même branche CLASSIFY_EVENT du master T4 que l'agenda
  // automatique (lot 16b-2 : `AgendaClassificationService` et le drapeau
  // `AI_AGENDA_ENGINE` sont retirés). Un échec du modèle rend la catégorie
  // prudente `action` (`classifyEventMaster`) — la création n'échoue jamais.
  // Import dynamique : évite de charger le moteur T4 (passerelle, file) au
  // chargement du service d'agenda, et tout cycle d'import.
  const homeCategoryResult = input.homeCategory ?? await (await import('@/services/ai/agenda/agenda-intelligence.service')).classifyAgendaCategory(
    {
      title: input.title,
      description: input.description,
      originType: input.originType ?? 'manual',
      originFieldKey: input.originFieldKey,
    },
    { accountId, userId: createdByUserId ?? undefined },
  );

  // 4. Primitive commune (CDC 15 T4-09) : ligne + liens en une transaction,
  // liens source (pièces jointes), recopie « achat » (D-13) et
  // notification des biens liés (D-14).
  const written = await upsertAgendaItem(
    manualUpsertInput(input, accountId, createdByUserId, homeCategoryResult),
    { actorUserId: createdByUserId, validate: false, notify: true, purchaseSync: {} },
  );

  const full = await getAgendaItemById(written.id, accountId);
  if (!full) throw new Error('Item created but not found');

  // Lot 47B (C4 TRG-012) : élément saisi qui décrit une intervention → T3
  // (source AGENDA). Un rappel, une échéance, un élément sans bien : rien.
  await notifyLinkedOperation(accountId, full.id, true, undefined, full);
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
      requiresQualification: input.requiresQualification ?? false,
      isAutomatic: input.isAutomatic ?? false,
      originType: input.originType ?? 'manual',
      originRefType: input.originRefType ?? null,
      originRefId: input.originRefId ?? null,
      // Lot 77A : écrite seulement si l'utilisateur a coché l'option.
      ...(input.noDeadline ? { noDeadline: true } : {}),
      // Lot 114V : écrite seulement si le service l'a résolue (choix transmis ou défaut manuel).
      ...(input.situation ? { situation: input.situation, situationSource: input.situationSource ?? 'USER' } : {}),
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
  accountId: number,
  actorUserId: number | null = null,
  clock: AgendaWriteClock = {},
): Promise<AgendaItemFull> {
  const existing = await getAgendaItemById(id, accountId);
  if (!existing) throw new Error('Item not found');

  // Lot 77A : « Sans échéance » — cochée, la date (et les heures) sont
  // neutralisées ; une date saisie la retire ; les deux à la fois : refus.
  const sansEcheance = resolveNoDeadlineWrite(input);
  if (!sansEcheance.ok) throw new AgendaValidationError(sansEcheance.error);
  if (sansEcheance.clearDates) input = { ...input, startDate: null, startTime: null, endDate: null, endTime: null };
  let noDeadlineEcrit: boolean | undefined = sansEcheance.noDeadline;

  // Lot 114V (#742) : situation de l'événement — le COUPLE situation / date
  // de début après l'écriture est contrôlé dès que l'une des deux change
  // (« A eu lieu » + date future : refus explicite, rien n'est écrit). Sans
  // situation transmise, celle de l'élément est conservée (un élément non
  // qualifié le reste : jamais reclassé d'office).
  const situationAvant = situationOf(existing.situation);
  const situation = resolveSituationWrite({
    situation: input.situation,
    effectiveStartDate: sansEcheance.clearDates ? null : input.startDate !== undefined ? input.startDate : existing.startDate,
    requestedNoDeadline: sansEcheance.noDeadline === true,
    existing: situationAvant,
    coupleTouched: input.startDate !== undefined || sansEcheance.clearDates,
    today: clock.today ?? todayParisDateStr(),
  });
  if (!situation.ok) throw new AgendaValidationError(situation.error);
  const situationChange = situation.situation !== undefined;
  // « A eu lieu » : l'option « Sans échéance » déjà en base est retirée (elle ne décrit qu'une tâche à prévoir).
  if (situationChange && situation.situation === 'A_EU_LIEU' && existing.noDeadline === true && noDeadlineEcrit === undefined) noDeadlineEcrit = false;
  const noDeadlineChange = noDeadlineEcrit !== undefined && noDeadlineEcrit !== (existing.noDeadline ?? false);

  const assetIds = input.assetIds ?? existing.assetLinks.map(l => l.assetId);
  const fileIds = input.fileIds ?? existing.fileLinks.map(l => l.assetFileId);
  let substructureIds = input.substructureIds ?? existing.roomLinks.map(l => l.substructureId);
  let equipmentIds = input.equipmentIds ?? existing.equipmentLinks.map(l => l.equipmentId);

  // Lot 103D : pièces / équipements seulement pour un logement rattaché. Un lien
  // DÉJÀ présent rendu incompatible (logement retiré) n'est dissocié que sur
  // confirmation explicite, dans cette même écriture ; un lien NOUVEAU
  // incompatible est toujours refusé. Rien n'est écrit en cas de refus.
  const dissocies = await (async () => {
    const plan = await planStructuralLinks(drizzleRunner(db), accountId, { assetIds, substructureIds, equipmentIds });
    if (!plan.roomIds.length && !plan.equipmentIds.length) return null;
    const dejaLiees = new Set(existing.roomLinks.map((l) => l.substructureId));
    const dejaLies = new Set(existing.equipmentLinks.map((l) => l.equipmentId));
    const nouveaux = plan.roomIds.some((id) => !dejaLiees.has(id)) || plan.equipmentIds.some((id) => !dejaLies.has(id));
    const ko = { roomIds: plan.roomIds, equipmentIds: plan.equipmentIds };
    if (nouveaux) {
      logStructuralLinkDecision('refused', { accountId, agendaItemId: id, ...ko });
      throw new AgendaStructuralLinkError(ko, 'INCOMPATIBLE');
    }
    if (input.dissociateIncompatible !== true) {
      logStructuralLinkDecision('dependents', { accountId, agendaItemId: id, ...ko });
      throw new AgendaStructuralLinkError(ko, 'DEPENDENTS');
    }
    return { before: { roomIds: [...substructureIds], equipmentIds: [...equipmentIds] }, removed: ko };
  })();
  if (dissocies) {
    substructureIds = substructureIds.filter((x) => !dissocies.removed.roomIds.includes(x));
    equipmentIds = equipmentIds.filter((x) => !dissocies.removed.equipmentIds.includes(x));
  }

  await validateAgendaWrite(sansEcheance.clearDates ? {
    startDate: null, startTime: null, endDate: null, endTime: null,
  } : {
    startDate: input.startDate ?? existing.startDate,
    startTime: input.startTime ?? existing.startTime,
    endDate: input.endDate ?? existing.endDate,
    endTime: input.endTime ?? existing.endTime,
  }, { assetIds, fileIds, substructureIds, equipmentIds }, accountId);

  // Detect if automatic item has been manually modified
  // (lot 77A : cocher / décocher « Sans échéance » est une modification de
  // l'utilisateur — T4 ne réécrit plus l'élément).
  const isAutomaticModified = existing.isAutomatic &&
    (input.title !== undefined || input.description !== undefined ||
     input.startDate !== undefined || input.startTime !== undefined ||
     input.endDate !== undefined || input.endTime !== undefined || noDeadlineChange
     // Lot 114V : qualifier la situation est une décision de l'utilisateur — T4 ne réécrit plus l'élément.
     || situationChange);

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
      ...(noDeadlineEcrit !== undefined ? { noDeadline: noDeadlineEcrit } : {}),
      ...(situationChange ? { situation: situation.situation, situationSource: situation.source } : {}),
      extra: confirmeParUtilisateur ? {
        occurrenceNature: 'CONFIRMED',
        dateSource: 'USER',
        forecastInitialDate: existing.forecastInitialDate ?? existing.startDate,
        confirmedAt: new Date(),
        confirmationMode: 'USER',
      } : {},
    },
  }, { linkMode: 'replace', validate: false });

  // Lot 103D : dissociation confirmée — journal avant / après (liens seulement, aucun objet supprimé).
  if (dissocies) {
    const { recordOccurrenceEvent } = await import('./agenda-persistence');
    await recordOccurrenceEvent(id, accountId, 'STRUCTURAL_LINKS_DISSOCIATED', {
      reason: 'USER_CONFIRMED_HOUSING_REMOVAL', removed: dissocies.removed, before: dissocies.before,
      after: { roomIds: substructureIds, equipmentIds, assetIds },
    }, actorUserId);
    logStructuralLinkDecision('dissociated', { accountId, agendaItemId: id, origin: 'USER', ...dissocies.removed });
  }

  if (isAutomaticModified || confirmeParUtilisateur) {
    const { recordOccurrenceEvent } = await import('./agenda-persistence');
    await recordOccurrenceEvent(id, accountId, confirmeParUtilisateur ? 'USER_CONFIRMED' : 'USER_MODIFIED', {
      before: { title: existing.title, date: existing.startDate, nature: existing.occurrenceNature },
      after: { title: input.title ?? existing.title, date: input.startDate ?? existing.startDate },
    }, null);
  }

  // Recopie « achat » (D-13).
  await syncPurchaseDate({ itemId: id, accountId, actorUserId: null });

  const full = await getAgendaItemById(id, accountId);
  if (!full) throw new Error('Item not found after update');

  // Lot 77A : option « Sans échéance » cochée / retirée (ou retirée par une
  // date) — tracée, puis la règle « À traiter » DATA-AGENDA-DATE est
  // réévaluée IMMÉDIATEMENT pour cet élément (fermeture motivée, ou
  // réouverture de la même carte), sans attendre le balayage horaire.
  if ((existing.noDeadline ?? false) !== (full.noDeadline ?? false)) {
    const { recordOccurrenceEvent } = await import('./agenda-persistence');
    await recordOccurrenceEvent(id, accountId, full.noDeadline ? 'NO_DEADLINE_SET' : 'NO_DEADLINE_CLEARED', {
      before: { date: existing.startDate, noDeadline: existing.noDeadline ?? false },
      after: { date: full.startDate, noDeadline: full.noDeadline ?? false },
    }, actorUserId);
    await refreshAgendaDateCard(accountId, id);
  }

  // Lot 114V (#742) : situation qualifiée ou changée par l'utilisateur —
  // tracée (avant / après, auteur), puis : carte de qualification « À
  // traiter » réévaluée IMMÉDIATEMENT (fermée, jamais régénérée : la décision
  // est persistée sur l'élément) et rappels d'échéance réévalués (« A eu
  // lieu » : la couverture en file est annulée ; « À prévoir » daté : rappel
  // normal). Aucun élément créé, aucun lien touché.
  if (situationOf(full.situation) !== situationAvant) {
    const { recordOccurrenceEvent } = await import('./agenda-persistence');
    await recordOccurrenceEvent(id, accountId, 'SITUATION_SET', {
      before: { situation: situationAvant, date: existing.startDate },
      after: { situation: situationOf(full.situation), date: full.startDate },
      source: 'USER',
    }, actorUserId);
    if ((existing.noDeadline ?? false) === (full.noDeadline ?? false)) await refreshAgendaDateCard(accountId, id);
    const { evaluerRappelEcheance } = await import('./write-agenda-item');
    await evaluerRappelEcheance(accountId, id);
  }

  // Lot 46 (O7, C4 déclencheur Agenda) : correction utilisateur d'un élément
  // lié à une Opération → T3, seulement si un champ a réellement changé.
  await notifyLinkedOperation(accountId, id, userFieldsChanged(existing, full), undefined, full);

  return full;
}

/**
 * Lot 77A : réévaluation immédiate de la règle DATA-AGENDA-DATE pour un
 * élément (même producteur que le balayage, déclencheur USER). Ne fait
 * jamais échouer l'écriture : le balayage horaire reste le filet.
 */
async function refreshAgendaDateCard(accountId: number, id: number): Promise<void> {
  try {
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    await produceAgendaActions(accountId, { trigger: 'USER', only: [id] });
  } catch (e) {
    console.error(`[agenda] réévaluation « À traiter » de l'élément ${id} :`, (e as Error).message);
  }
}

/** Un champ visible par l'utilisateur a-t-il changé (titre, description, dates, heures, liens) ? */
export function userFieldsChanged(before: AgendaItemFull, after: AgendaItemFull): boolean {
  const ids = (l: Array<{ [k: string]: unknown }>, k: string) => l.map((x) => Number(x[k])).sort((a, b) => a - b).join(',');
  return before.title !== after.title || (before.description ?? null) !== (after.description ?? null)
    || before.startDate !== after.startDate || before.startTime !== after.startTime
    || before.endDate !== after.endDate || before.endTime !== after.endTime
    || ids(before.assetLinks, 'assetId') !== ids(after.assetLinks, 'assetId')
    || ids(before.fileLinks, 'assetFileId') !== ids(after.fileLinks, 'assetFileId')
    || ids(before.roomLinks, 'substructureId') !== ids(after.roomLinks, 'substructureId')
    || ids(before.equipmentLinks, 'equipmentId') !== ids(after.equipmentLinks, 'equipmentId');
}

/** Opération représentée par l'élément (lien `business_operation_id`), ou null. */
async function linkedOperationId(accountId: number, id: number): Promise<number | null> {
  const [r] = await db.select({ op: agendaItems.businessOperationId }).from(agendaItems)
    .where(and(eq(agendaItems.id, id), eq(agendaItems.accountId, accountId))).limit(1);
  return r?.op ?? null;
}

/**
 * Déclencheur Agenda → T3 (C4) ; ne lève jamais. Élément lié à une
 * Opération : toujours (TRG-013 / TRG-014). Lot 47B (TRG-012) : élément non
 * lié seulement s'il peut établir une intervention (`full` connu : saisi,
 * daté, rattaché à un bien, intitulé d'intervention, ni rappel ni échéance).
 */
async function notifyLinkedOperation(accountId: number, id: number, changed: boolean, known?: number | null, full?: AgendaItemFull): Promise<void> {
  if (!changed) return;
  try {
    const op = known !== undefined ? known : await linkedOperationId(accountId, id);
    let candidate = false;
    if (op === null) {
      if (!full) return;
      const { agendaItemMayEstablishOperation } = await import('@/services/business-operations/consolidation/agenda-source');
      candidate = agendaItemMayEstablishOperation({
        isAutomatic: full.isAutomatic, title: full.title, startDate: full.startDate,
        assetCount: full.assetLinks.length + full.equipmentLinks.filter((e) => e.resolvedAssetId !== null).length,
      });
      if (!candidate) return;
    }
    const { notifyAgendaChangedForOperations } = await import('@/services/business-operations/agenda-projection/queue');
    notifyAgendaChangedForOperations(accountId, { itemId: id, businessOperationId: op, userFieldsChanged: true, candidate });
  } catch (e) {
    console.error(`[agenda] déclencheur Agenda de l'élément ${id} :`, (e as Error).message);
  }
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

/**
 * Lot 113P (#715, décision PO du 06/11/2026) : l'ancien `updateManualStatus`
 * (« Réalisé » / « Annulé ») est SUPPRIMÉ — un événement n'a plus de statut ;
 * un événement inexistant ou annulé est supprimé (`deleteAgendaItem`).
 */

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
export async function deleteAgendaItem(
  id: number, accountId: number, actorUserId: number | null = null,
  opts: { scope?: AgendaDeletionScope } = {},
): Promise<{ deletedIds: number[] }> {
  const existing = await getAgendaItemById(id, accountId);
  if (!existing) throw new Error('Item not found');
  // Lot 113P (#715) : récurrence — suppression de CETTE occurrence (défaut) ou
  // de TOUTE LA SÉRIE (même `series_key`, même compte), demandée explicitement.
  const scope: AgendaDeletionScope = opts.scope === 'SERIES' && existing.seriesKey ? 'SERIES' : 'OCCURRENCE';
  const ids = scope === 'SERIES'
    ? (await db.select({ id: agendaItems.id }).from(agendaItems)
      .where(and(eq(agendaItems.accountId, accountId), eq(agendaItems.seriesKey, existing.seriesKey!)))).map((r) => r.id)
    : [id];
  const operations = new Map<number, number | null>();
  for (const x of ids) operations.set(x, await linkedOperationId(accountId, x));
  for (const x of ids) await deleteOneAgendaItem(x, accountId, actorUserId, operations.get(x) ?? null, scope);
  // Lot 46 (O7, C4 TRG-014) : suppression utilisateur d'un élément lié → T3.
  for (const x of ids) await notifyLinkedOperation(accountId, x, true, operations.get(x) ?? null);
  return { deletedIds: ids };
}

/** Suppression d'UN élément (transaction unique), trace d'exclusion comprise. */
async function deleteOneAgendaItem(
  id: number, accountId: number, actorUserId: number | null, operationId: number | null, scope: AgendaDeletionScope,
): Promise<void> {
  await db.transaction(async tx => {
    // 00. Lot 113P (#715) : TRACE PERSISTANTE D'EXCLUSION (`agenda_item_removals`,
    //     USER_DELETED / USER_DELETED_SERIES) écrite AVANT la suppression, dans la
    //     même transaction (image des liens encore lisible) : aucune réanalyse
    //     (T1, T3, T4, cohérence) ne recrée cet événement depuis les mêmes sources.
    //     Isolée (point de sauvegarde) : elle ne bloque jamais la suppression demandée.
    await detachSafely(tx, 'agenda_item_removals (suppression utilisateur)', async (t) => {
      const { recordUserDeletion } = await import('./agenda-user-deletion');
      await recordUserDeletion(t, { accountId, ids: [id], scope, userId: actorUserId });
    });
    // 0. Lot 46 (O7, C16.1, F-146) : l'élément représente une Opération
    //    (projeté, ou lié) — la suppression est MÉMORISÉE : la projection ne
    //    le recréera pas. Isolée (point de sauvegarde) : elle ne bloque
    //    jamais la suppression demandée.
    if (operationId !== null) {
      await detachSafely(tx, 'business_operation_projection_suppressions', async (t) => {
        const { recordAgendaProjectionSuppression } = await import('@/services/business-operations/agenda-projection/service');
        await recordAgendaProjectionSuppression(t, { accountId, itemId: id, userId: actorUserId });
      });
    }

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
  // Lot 47B : la confirmation est un geste utilisateur (élément désormais « modifié »).
  await notifyLinkedOperation(accountId, id, true, undefined, full);
  return full;
}
