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

/**
 * ⚠️ `OPEN_SUPPLIER` et `OPEN_SUPPLIERS` restent au catalogue (le type est une
 * union fermée, §22.11) mais ne sont plus proposés par aucune intention :
 * l'application n'expose pas de route `/fournisseurs`. Les rétablir suppose
 * d'ouvrir la page correspondante d'abord.
 */
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
  OPEN_HELP: A('OPEN_HELP', 'Aide Verebona', ['helpEntryId', 'path'], 'published_help'),
  // Formulaire de contact du Centre d'aide : route fixe, sans objet du compte.
  OPEN_CONTACT: A('OPEN_CONTACT', 'Contacter le support', [], 'account_route'),
  START_ADD_ASSET: A('START_ADD_ASSET', 'Création bien', ['assetType'], 'supported_type'),
  START_ADD_DOCUMENT: A('START_ADD_DOCUMENT', 'Ajout document', ['assetId'], 'account_object'),
  START_ADD_AGENDA_ITEM: A('START_ADD_AGENDA_ITEM', 'Création échéance', ['assetId'], 'account_object'),
  // Corrigé : l'espace d'export n'existe que DANS une fiche bien
  // (`/assets/[id]?tab=exports`). Sans bien cible il n'y a pas de page, le
  // contrôle est donc celui d'un objet du compte, pas d'une route libre.
  OPEN_EXPORT_AREA: A('OPEN_EXPORT_AREA', 'Zone exports', ['assetId', 'exportType'], 'account_object'),
  // Actions non-métier (ne comptent pas dans la limite 1+2 — §22.9)
  SHOW_SOURCES: A('SHOW_SOURCES', 'Sources de la réponse', ['messageId'], 'message_owner', false),
  SHOW_EXPLANATION: A('SHOW_EXPLANATION', 'Explication', ['messageId'], 'message_owner', false),
  RETRY_REQUEST: A('RETRY_REQUEST', 'Nouvelle tentative', ['messageId'], 'recoverable_request', false),
};

/** Types d'actions autorisés par intention (§22.1). */
export const INTENT_ALLOWED_ACTIONS: Partial<Record<VerebonaIntent, VerebonaActionType[]>> = {
  // Dictionnaire de navigation (core/navigation-targets.ts) : agenda, À
  // traiter, documents, compte, offres, aide — une seule action retenue.
  NAVIGATION_OPEN: ['OPEN_ASSET', 'OPEN_DOCUMENT', 'OPEN_AGENDA', 'OPEN_AGENDA_ITEM', 'OPEN_TO_PROCESS', 'OPEN_ACCOUNT', 'OPEN_DOCUMENTS_PAGE', 'OPEN_PRICING', 'OPEN_HELP'],
  // OPEN_CONTACT sur toutes les intentions d'aide : renvoi au support quand
  // le corpus ne répond pas ou se contredit (CDC Centre d'aide §5, T2-04).
  NAVIGATION_FIND: ['OPEN_HELP', 'OPEN_DOCUMENTS_PAGE', 'OPEN_AGENDA', 'OPEN_TO_PROCESS', 'OPEN_CONTACT'],
  PRODUCT_HELP_HOW_TO: ['OPEN_HELP', 'START_ADD_DOCUMENT', 'START_ADD_ASSET', 'START_ADD_AGENDA_ITEM', 'OPEN_CONTACT'],
  // « À quoi sert À traiter ? » → bouton « Ouvrir « À traiter » » (37.4,
  // §10.5) : la page expliquée est la suite la plus utile.
  PRODUCT_HELP_EXPLAIN: ['OPEN_HELP', 'OPEN_TO_PROCESS', 'OPEN_AGENDA', 'OPEN_DOCUMENTS_PAGE', 'OPEN_CONTACT'],
  PRODUCT_HELP_STATUS: ['OPEN_HELP', 'OPEN_TO_PROCESS', 'OPEN_CONTACT'],
  PRODUCT_PLAN_LIMIT: ['OPEN_PRICING'],
  ACCOUNT_SEARCH_ASSET: ['OPEN_ASSET', 'OPEN_SEARCH_RESULTS'],
  ACCOUNT_SEARCH_DOCUMENT: ['OPEN_DOCUMENT', 'OPEN_DOCUMENTS_PAGE', 'OPEN_SEARCH_RESULTS'],
  ACCOUNT_SEARCH_AGENDA: ['OPEN_AGENDA_ITEM', 'OPEN_AGENDA'],
  // Les fournisseurs n'ont pas de page dédiée : ils se consultent depuis les
  // documents et les équipements qui les référencent. On oriente donc vers
  // les documents plutôt que vers une route inexistante.
  ACCOUNT_SEARCH_SUPPLIER: ['OPEN_DOCUMENTS_PAGE', 'OPEN_DOCUMENT'],
  ACCOUNT_FACT_ASSET: ['OPEN_ASSET', 'OPEN_DOCUMENT', 'SHOW_SOURCES'],
  ACCOUNT_FACT_DOCUMENT: ['OPEN_DOCUMENT', 'SHOW_SOURCES'],
  ACCOUNT_FACT_AGENDA: ['OPEN_AGENDA_ITEM', 'SHOW_SOURCES'],
  ACCOUNT_TO_PROCESS: ['OPEN_TO_PROCESS'],
  ACCOUNT_MISSING_INFORMATION: ['OPEN_ASSET', 'START_ADD_DOCUMENT', 'OPEN_TO_PROCESS'],
  ACCOUNT_SUMMARY: ['OPEN_DOCUMENT', 'SHOW_SOURCES', 'SHOW_EXPLANATION'],
  ACCOUNT_COMPARISON: ['OPEN_DOCUMENT', 'SHOW_SOURCES', 'SHOW_EXPLANATION', 'OPEN_TO_PROCESS'],
  ACCOUNT_TIMELINE: ['OPEN_DOCUMENT', 'OPEN_AGENDA_ITEM', 'SHOW_SOURCES'],
  EXPORT_HELP: ['OPEN_EXPORT_AREA', 'OPEN_HELP', 'OPEN_CONTACT'],
  TECHNICAL_ISSUE: ['OPEN_HELP', 'RETRY_REQUEST', 'OPEN_CONTACT'],
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
