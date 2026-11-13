/**
 * Catalogue des actions de l'assistant, par NATURE — CDC BO IA.
 *
 *   · navigation     : ouvre un écran ou un objet (OPEN_*) — aucune écriture ;
 *   · start_flow     : démarre un parcours de saisie (START_*) — l'écriture
 *                      se fait ensuite dans le formulaire classique ;
 *   · write_command  : commande métier exécutée depuis le chat, APRÈS
 *                      confirmation explicite d'un plan préparé et figé.
 *
 * Les commandes d'écriture n'embarquent aucune règle métier : chacune
 * appelle le service existant de l'interface classique (voir executors.ts).
 */
import type { VerebonaActionType } from '../types/actions';

export type ActionKind = 'navigation' | 'start_flow' | 'write_command' | 'display';

export function actionKind(type: VerebonaActionType | WriteCommandType): ActionKind {
  if ((WRITE_COMMANDS as readonly string[]).includes(type)) return 'write_command';
  if (type.startsWith('START_')) return 'start_flow';
  if (type.startsWith('OPEN_')) return 'navigation';
  return 'display';
}

/**
 * Lot 113P (#715) : MARK_AGENDA_DONE / CANCEL_AGENDA_ITEM retirées — un événement
 * n'a plus de statut (« réalisée » / « annulée ») ; il se modifie ou se supprime.
 */
/**
 * Lot 114B (Trello #753, CDC T2 §9.2, §14.3, M16) — catalogue FERMÉ étendu :
 * UPDATE_AGENDA_ITEM (W16) et DELETE_AGENDA_ITEM (W17). Aucun statut d'événement
 * n'est réintroduit : un événement se modifie ou se supprime, par le service de
 * l'Agenda (`updateAgendaItem`, `deleteAgendaItem`), comme depuis son tiroir.
 */
const WRITE_COMMANDS = [
  'CREATE_AGENDA_ITEM', 'UPDATE_ASSET_FIELD', 'UPDATE_AGENDA_ITEM', 'DELETE_AGENDA_ITEM',
  // Biens (W01, W03) : par la façade métier `asset-write.facade`, la même que la route.
  'CREATE_ASSET', 'DELETE_ASSET',
] as const;
export type WriteCommandType = (typeof WRITE_COMMANDS)[number];

interface WriteCommandDefinition {
  type: WriteCommandType;
  label: string;
  /** Service métier appelé à l'exécution (documentation / trace). */
  service: string;
  /** Contrôle d'accès : compte en écriture + objet du compte. */
  requiresWriteAccess: true;
  /**
   * Lot 114B (#753, CDC T2 §14.3) — fiche de la commande, exigée avant activation :
   * capacité métier, cible, lecture avant écriture, politiques de suppression
   * et d'annulation, effets, événement de succès, sûreté d'un rejeu. Facultative
   * pour les deux commandes historiques (déjà recettées).
   */
  spec?: {
    capabilityCode: string;
    targetKind: 'asset' | 'agenda_item';
    requiredFields: readonly string[];
    optionalFields: readonly string[];
    readBeforeWrite: boolean;
    deletePolicy: 'NONE' | 'HARD_DELETE_WITH_EXCLUSION_TRACE' | 'HARD_DELETE_WITH_CONTENT';
    undoPolicy: 'REVERSIBLE_15_MIN' | 'IRREVERSIBLE';
    sideEffects: readonly string[];
    successEvent: string;
    /** Un second envoi de la même confirmation ne rejoue jamais l'écriture (prise atomique du plan). */
    retrySafety: 'PLAN_TAKEN_ONCE';
  };
}

export const WRITE_COMMAND_CATALOG: Record<WriteCommandType, WriteCommandDefinition> = {
  CREATE_AGENDA_ITEM: {
    type: 'CREATE_AGENDA_ITEM', label: 'Créer une échéance',
    service: 'AgendaWriteService.createAgendaItem', requiresWriteAccess: true,
  },
  UPDATE_ASSET_FIELD: {
    type: 'UPDATE_ASSET_FIELD', label: 'Modifier une caractéristique d’un bien',
    service: 'asset-details-write.service.updateAssetDetails', requiresWriteAccess: true,
  },
  UPDATE_AGENDA_ITEM: {
    type: 'UPDATE_AGENDA_ITEM', label: 'Modifier une échéance',
    service: 'AgendaWriteService.updateAgendaItem', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'AGENDA_UPDATE', targetKind: 'agenda_item',
      requiredFields: ['agendaItemId', 'expectedVersion'], optionalFields: ['title', 'startDate'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['rappels de l’échéance recalculés par l’Agenda'], successEvent: 'AGENDA_ITEM_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  DELETE_AGENDA_ITEM: {
    type: 'DELETE_AGENDA_ITEM', label: 'Supprimer une échéance',
    service: 'AgendaWriteService.deleteAgendaItem', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'AGENDA_DELETE', targetKind: 'agenda_item',
      requiredFields: ['agendaItemId', 'scope', 'expectedVersion', 'expectedCount'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'HARD_DELETE_WITH_EXCLUSION_TRACE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['liens vers les biens et les documents retirés', 'une réanalyse ne recrée pas l’échéance supprimée'],
      successEvent: 'AGENDA_ITEM_DELETED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  CREATE_ASSET: {
    type: 'CREATE_ASSET', label: 'Créer un bien',
    service: 'asset-write.facade.createAssetForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ASSET_CREATE', targetKind: 'asset',
      requiredFields: ['category', 'name'], optionalFields: ['subtype', 'objectCategory'],
      readBeforeWrite: true, deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['quota de biens de l’offre', 'reprise des documents et faits encore ouverts du compte (T3)'],
      successEvent: 'ASSET_CREATED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
  DELETE_ASSET: {
    type: 'DELETE_ASSET', label: 'Supprimer un bien',
    service: 'asset-write.facade.deleteAssetForAccount', requiresWriteAccess: true,
    spec: {
      capabilityCode: 'ASSET_DELETE', targetKind: 'asset',
      requiredFields: ['assetId', 'expectedSummary'], optionalFields: [],
      readBeforeWrite: true, deletePolicy: 'HARD_DELETE_WITH_CONTENT', undoPolicy: 'IRREVERSIBLE',
      sideEffects: ['documents, photos, échéances, événements, pièces et équipements du bien supprimés', 'fichiers stockés purgés', 'preuves retirées sur les autres biens'],
      successEvent: 'ASSET_DELETED', retrySafety: 'PLAN_TAKEN_ONCE',
    },
  },
};

/** Paramètres figés d'une action préparée. */
export type CommandParams =
  // CREATE_AGENDA_ITEM — lot 114B (#753, W15) : `startDate: null` = date inconnue (« Sans date ») ;
  // `noDeadline: true` = option « Sans échéance » explicitement demandée. Les deux ne se confondent pas.
  | { title: string; startDate: string | null; assetIds: number[]; noDeadline?: boolean }
  | {                                                                   // UPDATE_ASSET_FIELD
      assetId: number; section: string; field: string;
      value: string | number;
      /** Valeur présentée comme « ancienne » : l'exécution refuse si elle a changé depuis. */
      previous: unknown;
    }
  // UPDATE_AGENDA_ITEM (W16) : seuls le titre et la date sont modifiables depuis l'Assistant.
  | { kind: 'agenda_update'; agendaItemId: number; patch: { title?: string; startDate?: string | null }; expectedVersion: string }
  // DELETE_AGENDA_ITEM (W17) : portée figée à la préparation — une série n'est pas une occurrence.
  | { kind: 'agenda_delete'; agendaItemId: number; scope: 'OCCURRENCE' | 'SERIES'; expectedVersion: string; expectedCount: number }
  // CREATE_ASSET (W01) : famille et catégorie du référentiel des biens, nom donné par l'utilisateur.
  | { kind: 'asset_create'; category: string; subtype: string | null; objectCategory: string | null; name: string }
  // DELETE_ASSET (W03) : le décompte présenté est figé — s'il change, rien n'est supprimé.
  | { kind: 'asset_delete'; assetId: number; expectedSummary: Record<string, number> };

/** Action d'un plan, préparée et figée avant toute confirmation. */
export interface PlannedAction {
  /** Identifiant de l'action dans le plan (« a1 », « a2 »…). */
  actionId: string;
  command: WriteCommandType;
  /** Cible(s), pour l'affichage et la trace. */
  targets: Array<{ type: 'asset' | 'agenda_item'; id: number; label: string }>;
  params: CommandParams;
  /** Actions dont celle-ci dépend (exécutée seulement si elles réussissent). */
  dependsOn: string[];
  /** Ce que l'utilisateur voit avant de confirmer. */
  preview: string;
  /** Principales conséquences / valeurs concernées. */
  effects: string[];
}

type ActionOutcome = 'SUCCESS' | 'FAILED' | 'SKIPPED_DEPENDENCY' | 'REFUSED';

export interface ActionResult {
  actionId: string;
  status: ActionOutcome;
  message: string;
  /** Objet créé ou modifié. */
  entity?: { type: 'agenda_item' | 'asset'; id: number } | null;
}

export type PlanStatus =
  | 'PENDING_CONFIRMATION' | 'EXECUTING' | 'EXECUTED' | 'PARTIAL' | 'FAILED'
  | 'CANCELLED' | 'EXPIRED' | 'REFUSED'
  /** Exécuté puis annulé par l'utilisateur dans la fenêtre prévue (undo.service). */
  | 'UNDONE';

/** Ce que le client reçoit : jamais les paramètres modifiables, seulement l'aperçu. */
export interface CommandPlanPreview {
  planId: string;
  summary: string;
  actions: Array<{ actionId: string; label: string; preview: string; effects: string[]; dependsOn: string[] }>;
  expiresAt: string;
}
