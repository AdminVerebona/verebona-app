/**
 * Registre des actions — CDC §22.4 / §22.7 / §22.11.
 *
 * Définit, pour chaque type d'action : cible, paramètres acceptés, contrôle d'accès,
 * et si c'est une action « métier ». Le mapping intention → types autorisés borne ce
 * que le modèle peut proposer (§22.1).
 */
import { ACTION_CATALOG_VERSION, type ActionDefinition, type VerebonaActionType } from '../types/actions';
import type { VerebonaIntent } from '../types/intents';

const A = (
  type: VerebonaActionType,
  target: string,
  paramKeys: string[],
  control: ActionDefinition['control'],
  isBusinessAction = true,
): ActionDefinition => ({ type, target, paramKeys, control, isBusinessAction });

export const ACTION_DEFINITIONS: Record<VerebonaActionType, ActionDefinition> = {
  OPEN_ASSET: A('OPEN_ASSET', "Fiche d'un bien", ['assetId'], 'account_object'),
  OPEN_DOCUMENT: A('OPEN_DOCUMENT', 'Document', ['documentId'], 'account_object'),
  OPEN_DOCUMENTS_PAGE: A('OPEN_DOCUMENTS_PAGE', 'Liste documents', ['filters'], 'account_route'),
  OPEN_SEARCH_RESULTS: A('OPEN_SEARCH_RESULTS', 'Résultats de recherche', ['searchToken'], 'signed_token'),
  OPEN_AGENDA: A('OPEN_AGENDA', 'Agenda', ['filters'], 'account_route'),
  OPEN_AGENDA_ITEM: A('OPEN_AGENDA_ITEM', 'Détail échéance', ['agendaItemId'], 'account_object'),
  OPEN_TO_PROCESS: A('OPEN_TO_PROCESS', 'Page À traiter', ['filters'], 'account_route'),
  OPEN_SUPPLIERS: A('OPEN_SUPPLIERS', 'Liste fournisseurs', [], 'account_route'),
  OPEN_SUPPLIER: A('OPEN_SUPPLIER', 'Fiche fournisseur', ['supplierId'], 'account_object'),
  OPEN_ACCOUNT: A('OPEN_ACCOUNT', 'Mon compte', ['section'], 'account_route'),
  OPEN_PRICING: A('OPEN_PRICING', 'Page des offres', ['offer'], 'known_offer'),
  OPEN_HELP: A('OPEN_HELP', 'Aide Verebona', ['helpEntryId'], 'published_help'),
  START_ADD_ASSET: A('START_ADD_ASSET', 'Création bien', ['assetType'], 'supported_type'),
  START_ADD_DOCUMENT: A('START_ADD_DOCUMENT', 'Ajout document', ['assetId'], 'account_object'),
  START_ADD_AGENDA_ITEM: A('START_ADD_AGENDA_ITEM', 'Création échéance', ['assetId'], 'account_object'),
  OPEN_EXPORT_AREA: A('OPEN_EXPORT_AREA', 'Zone exports', ['assetId', 'exportType'], 'account_route'),
  // Actions non-métier (ne comptent pas dans la limite 1+2 — §22.9)
  SHOW_SOURCES: A('SHOW_SOURCES', 'Sources de la réponse', ['messageId'], 'message_owner', false),
  SHOW_EXPLANATION: A('SHOW_EXPLANATION', 'Explication', ['messageId'], 'message_owner', false),
  RETRY_REQUEST: A('RETRY_REQUEST', 'Nouvelle tentative', ['messageId'], 'recoverable_request', false),
};

/** Types d'actions autorisés par intention (§22.1). */
export const INTENT_ALLOWED_ACTIONS: Partial<Record<VerebonaIntent, VerebonaActionType[]>> = {
  NAVIGATION_OPEN: ['OPEN_ASSET', 'OPEN_DOCUMENT', 'OPEN_AGENDA', 'OPEN_AGENDA_ITEM', 'OPEN_TO_PROCESS', 'OPEN_SUPPLIERS', 'OPEN_SUPPLIER', 'OPEN_ACCOUNT', 'OPEN_DOCUMENTS_PAGE'],
  NAVIGATION_FIND: ['OPEN_HELP', 'OPEN_DOCUMENTS_PAGE', 'OPEN_AGENDA', 'OPEN_TO_PROCESS'],
  PRODUCT_HELP_HOW_TO: ['OPEN_HELP', 'START_ADD_DOCUMENT', 'START_ADD_ASSET', 'START_ADD_AGENDA_ITEM'],
  PRODUCT_HELP_EXPLAIN: ['OPEN_HELP'],
  PRODUCT_HELP_STATUS: ['OPEN_HELP', 'OPEN_TO_PROCESS'],
  PRODUCT_PLAN_LIMIT: ['OPEN_PRICING'],
  ACCOUNT_SEARCH_ASSET: ['OPEN_ASSET', 'OPEN_SEARCH_RESULTS'],
  ACCOUNT_SEARCH_DOCUMENT: ['OPEN_DOCUMENT', 'OPEN_DOCUMENTS_PAGE', 'OPEN_SEARCH_RESULTS'],
  ACCOUNT_SEARCH_AGENDA: ['OPEN_AGENDA_ITEM', 'OPEN_AGENDA'],
  ACCOUNT_SEARCH_SUPPLIER: ['OPEN_SUPPLIER', 'OPEN_SUPPLIERS'],
  ACCOUNT_FACT_ASSET: ['OPEN_ASSET', 'OPEN_DOCUMENT', 'SHOW_SOURCES'],
  ACCOUNT_FACT_DOCUMENT: ['OPEN_DOCUMENT', 'SHOW_SOURCES'],
  ACCOUNT_FACT_AGENDA: ['OPEN_AGENDA_ITEM', 'SHOW_SOURCES'],
  ACCOUNT_TO_PROCESS: ['OPEN_TO_PROCESS'],
  ACCOUNT_MISSING_INFORMATION: ['OPEN_ASSET', 'START_ADD_DOCUMENT', 'OPEN_TO_PROCESS'],
  ACCOUNT_SUMMARY: ['OPEN_DOCUMENT', 'SHOW_SOURCES', 'SHOW_EXPLANATION'],
  ACCOUNT_COMPARISON: ['OPEN_DOCUMENT', 'SHOW_SOURCES', 'SHOW_EXPLANATION', 'OPEN_TO_PROCESS'],
  ACCOUNT_TIMELINE: ['OPEN_DOCUMENT', 'OPEN_AGENDA_ITEM', 'SHOW_SOURCES'],
  EXPORT_HELP: ['OPEN_EXPORT_AREA', 'OPEN_HELP'],
  TECHNICAL_ISSUE: ['OPEN_HELP', 'RETRY_REQUEST'],
  UNSUPPORTED_ACTION: ['OPEN_HELP'],
  SENSITIVE_ADVICE: ['OPEN_DOCUMENT', 'OPEN_HELP'],
};

export function getActionDefinition(type: VerebonaActionType): ActionDefinition {
  return ACTION_DEFINITIONS[type];
}

export function allowedActionsFor(intent: VerebonaIntent): VerebonaActionType[] {
  return INTENT_ALLOWED_ACTIONS[intent] ?? [];
}

export { ACTION_CATALOG_VERSION };
