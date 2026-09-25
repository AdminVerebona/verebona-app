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

export const WRITE_COMMANDS = ['CREATE_AGENDA_ITEM', 'MARK_AGENDA_DONE', 'CANCEL_AGENDA_ITEM', 'UPDATE_ASSET_FIELD'] as const;
export type WriteCommandType = (typeof WRITE_COMMANDS)[number];

export interface WriteCommandDefinition {
  type: WriteCommandType;
  label: string;
  /** Service métier appelé à l'exécution (documentation / trace). */
  service: string;
  /** Contrôle d'accès : compte en écriture + objet du compte. */
  requiresWriteAccess: true;
}

export const WRITE_COMMAND_CATALOG: Record<WriteCommandType, WriteCommandDefinition> = {
  CREATE_AGENDA_ITEM: {
    type: 'CREATE_AGENDA_ITEM', label: 'Créer une échéance',
    service: 'AgendaWriteService.createAgendaItem', requiresWriteAccess: true,
  },
  MARK_AGENDA_DONE: {
    type: 'MARK_AGENDA_DONE', label: 'Marquer une échéance comme réalisée',
    service: 'AgendaWriteService.updateManualStatus(realise)', requiresWriteAccess: true,
  },
  CANCEL_AGENDA_ITEM: {
    type: 'CANCEL_AGENDA_ITEM', label: 'Annuler une échéance',
    service: 'AgendaWriteService.updateManualStatus(annule)', requiresWriteAccess: true,
  },
  UPDATE_ASSET_FIELD: {
    type: 'UPDATE_ASSET_FIELD', label: 'Modifier une caractéristique d’un bien',
    service: 'asset-details-write.service.updateAssetDetails', requiresWriteAccess: true,
  },
};

/** Paramètres figés d'une action préparée. */
export type CommandParams =
  | { title: string; startDate: string; assetIds: number[] }            // CREATE_AGENDA_ITEM
  | { agendaItemId: number }                                            // MARK / CANCEL
  | {                                                                   // UPDATE_ASSET_FIELD
      assetId: number; section: string; field: string;
      value: string | number;
      /** Valeur présentée comme « ancienne » : l'exécution refuse si elle a changé depuis. */
      previous: unknown;
    };

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

export type ActionOutcome = 'SUCCESS' | 'FAILED' | 'SKIPPED_DEPENDENCY' | 'REFUSED';

export interface ActionResult {
  actionId: string;
  status: ActionOutcome;
  message: string;
  /** Objet créé ou modifié. */
  entity?: { type: 'agenda_item' | 'asset'; id: number } | null;
}

export type PlanStatus =
  | 'PENDING_CONFIRMATION' | 'EXECUTING' | 'EXECUTED' | 'PARTIAL' | 'FAILED'
  | 'CANCELLED' | 'EXPIRED' | 'REFUSED';

/** Ce que le client reçoit : jamais les paramètres modifiables, seulement l'aperçu. */
export interface CommandPlanPreview {
  planId: string;
  summary: string;
  actions: Array<{ actionId: string; label: string; preview: string; effects: string[]; dependsOn: string[] }>;
  expiresAt: string;
}
