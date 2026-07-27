/**
 * Catalogue FERMÉ des actions — CDC §22.4 / §22.11.
 *
 * Le modèle ne peut proposer QUE `type` + des identifiants figurant dans les entrées
 * autorisées (§22.6). Le serveur génère actionId/label/href/expiration/analytics et la
 * route finale (§22.7). Gemini ne produit JAMAIS d'URL libre (§22.1, §18.7).
 */

export const ACTION_CATALOG_VERSION = 'action-catalog-v1.0' as const;

export const VEREBONA_ACTION_TYPES = [
  'OPEN_ASSET',
  'OPEN_DOCUMENT',
  'OPEN_DOCUMENTS_PAGE',
  'OPEN_SEARCH_RESULTS',
  'OPEN_AGENDA',
  'OPEN_AGENDA_ITEM',
  'OPEN_TO_PROCESS',
  'OPEN_SUPPLIERS',
  'OPEN_SUPPLIER',
  'OPEN_ACCOUNT',
  'OPEN_PRICING',
  'OPEN_HELP',
  'START_ADD_ASSET',
  'START_ADD_DOCUMENT',
  'START_ADD_AGENDA_ITEM',
  'OPEN_EXPORT_AREA',
  'SHOW_SOURCES',
  'SHOW_EXPLANATION',
  'RETRY_REQUEST',
] as const;

export type VerebonaActionType = (typeof VEREBONA_ACTION_TYPES)[number];

/** Paramètres autorisés par type (validés côté serveur). */
export interface ActionDefinition {
  type: VerebonaActionType;
  /** Cible fonctionnelle (documentation). */
  target: string;
  /** Clés de payload acceptées. */
  paramKeys: ReadonlyArray<string>;
  /** Contrôle d'accès à appliquer avant résolution (§22.7). */
  control:
    | 'account_object'
    | 'account_route'
    | 'signed_token'
    | 'published_help'
    | 'known_offer'
    | 'message_owner'
    | 'recoverable_request'
    | 'supported_type';
  /** Action « métier » (compte dans la limite 1 principale + 2 secondaires, §22.9). */
  isBusinessAction: boolean;
}

/**
 * Ce que le MODÈLE a le droit de proposer (minimal). Tout le reste est généré serveur.
 * §22.6.
 */
export interface ActionIntent {
  type: VerebonaActionType;
  /** Identifiant d'une entité fournie dans le contexte, jamais inventé (§18.4). */
  targetId?: string | number | null;
  /** Filtres validés éventuels. */
  params?: Record<string, string | number | boolean | null>;
}

/**
 * Action finale renvoyée au front, entièrement résolue par le serveur (§22.6).
 * `href` est TOUJOURS construit serveur ; le client ne le reconstruit jamais (§27.1).
 */
export interface VerebonaAction {
  actionId: string;
  type: VerebonaActionType;
  label: string;
  href: string | null;
  /** Jeton interne signé si l'action passe par un token (ex : OPEN_SEARCH_RESULTS). */
  token?: string | null;
  requiresConfirmation: boolean;
  expiresAt: string | null;
  analyticsCode: string;
}

export function isVerebonaActionType(value: string): value is VerebonaActionType {
  return (VEREBONA_ACTION_TYPES as readonly string[]).includes(value);
}
