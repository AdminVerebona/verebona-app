/**
 * État canonique d'un bien — point d'entrée (CDC 15 §12 SVC-04, SVC-05).
 *
 *   getCanonicalAssetState()     lecture unique (CanonicalAssetView) ;
 *   writeCanonicalAssetField()   écriture unique (origine, miroirs, journal).
 */
export * from './types';
export {
  getCanonicalAssetState, buildCanonicalAssetState, readCanonicalValue, loadAssetRow,
  parseKc, isEmptyValue, fromMirrorColumn,
  type AssetRowJson, type SqlRunner,
} from './canonical-asset-view';
export {
  writeCanonicalAssetField, writeCanonicalAssetFields, observeLegacyWrite,
  planCanonicalWrites, divergenceOf, sameCanonicalValue, resolveDefForFamily,
  type WriteHooks, type WriteHookContext, type TxRunner, type WriteDivergence, type CanonicalWritePlan,
} from './write-canonical-asset-field';
export { readMirrorColumns, restoreMirrorColumns, ALL_MIRROR_COLUMNS } from './mirror-columns';
