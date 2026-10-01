/**
 * État canonique d'un ÉQUIPEMENT ou d'une PIÈCE — point d'entrée (CDC 15
 * T1-04, T3-01, T3-05 ; plan lot 18, volet R3).
 *
 *   getCanonicalEntityState()     lecture (fiche 0227, repli colonnes) ;
 *   writeCanonicalEntityField()   écriture unique (origine, miroirs, journal).
 */
export * from './types';
export {
  ENTITY_MIRRORS, buildCanonicalEntityState, fieldTargetsEntity, getCanonicalEntityState, listAssetEntities,
  listEntityFields, loadAssetEntityRows, loadEntityRow, readEntityFieldState, resolveEntityDef,
} from './entity-view';
export {
  planEntityWrites, recordManualEntityEdit, writeCanonicalEntityField, writeCanonicalEntityFields,
  type EntityWritePlan,
} from './write-canonical-entity-field';
export { entityCanonicalColumnsReady, __resetEntityColumnsForTests } from './entity-schema';
