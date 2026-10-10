/**
 * Couche A de T1 (lot 34F) — point d'entrée PUBLIC pour les consommateurs
 * (T3, interface de sources documentaires du lot 34E, traitements futurs).
 *
 * Lecture sans jamais rouvrir le fichier :
 *   loadDocumentSourceUnits(fileId, { statuses, kinds, pages, withFacts })
 *   loadDocumentCoverage(fileId)
 *   loadUnresolvedDocumentFacts(fileId)
 *   searchDocumentSourceUnits(accountId, terms, { statuses })
 */
export {
  loadDocumentSourceUnits, loadDocumentCoverage, loadUnresolvedDocumentFacts, searchDocumentSourceUnits,
  type StoredSourceUnit, type StoredCoverage, type StoredUnresolvedFact, type SourceUnitHit, type LoadSourceUnitsOptions,
} from './repository';
export { cellUnitId, rowUnitId, tableUnitId, unitOfCell, visualUnitId } from './build-units';
export {
  COVERAGE_STATUSES, SOURCE_UNIT_KINDS, T1_QUALITY_STATES, T1_COMPLETENESS_ANOMALIES,
  type CoverageStatus, type SourceUnitKind, type T1QualityState, type T1CompletenessReport, type UnresolvedReason,
} from './types';
