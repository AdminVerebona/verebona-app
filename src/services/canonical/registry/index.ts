/**
 * Registre canonique des champs — point d'entrée public (CDC 15 §5, §12).
 * Voir README.md pour les décisions (D-09, D-10, D-12) et les questions ouvertes.
 */
export * from './types';
export { CANONICAL_FIELDS, CONTEXTUAL_ALIASES, EXCLUDED_KEYS, REGISTRY_VERSION, type ContextualAliasRule } from './fields';
export {
  EVENT_CATALOG,
  DOCUMENT_CATALOG,
  getEventEntry,
  getDocumentEntry,
  resolveDocumentType,
  documentMayCreateEvent,
} from './catalogs';
export {
  getField,
  resolveAlias,
  resolveAliasDetailed,
  isContextualAlias,
  isInputOnlyKey,
  documentContextOf,
  type AliasContext,
  aliasToken,
  listFields,
  fieldTargetTypes,
  toAssetFamily,
  isExcludedKey,
  catalogForPrompts,
} from './registry';
export {
  normalizeValue,
  normalizeDateValue,
  toMirrorValue,
  toMirrorPatch,
  columnToProperty,
  eurToCents,
  centsToEur,
} from './normalize';
