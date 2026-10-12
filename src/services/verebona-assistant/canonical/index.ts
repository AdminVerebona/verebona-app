/**
 * Couche de lecture canonique de l'assistant — CDC 15 §9 (lot 15).
 * Point d'entrée public pour Y (recherche, routage) et Z (vérification).
 * Voir `repository.ts` pour l'ensemble, et chaque module pour sa règle.
 */
export {
  readCanonicalField, readCanonicalEntityField, EntityReadCache, openFieldConflicts, formatCanonicalValue, canonicalKeyOf, ORIGIN_LABELS,
  assetFieldSource, assetFieldSourceId, parseAssetFieldSourceId,
  type CanonicalFieldReading, type CanonicalFieldEvidence, type CanonicalFieldConflict, type CanonicalEntityFieldReading,
} from './field-reader';
export {
  getCanonicalDocumentState, documentAssetsOf, catalogCodeOf,
  type CanonicalDocumentState, type CanonicalDocumentAsset, type CanonicalDocumentFact,
} from './document-state';
export {
  getCanonicalAgendaItem, listUpcomingAgenda, countUpcomingAgenda, canonicalAgendaSource, agendaStatus4, HISTORICAL_FIELD_KEYS,
  type CanonicalAgendaItem, type AgendaStatus4, type UpcomingAgendaRow,
} from './agenda';
export {
  sumQualifiedExpenses, classifyExpenseDocument, aggregateExpenses, expenseThemeOf, EXPENSE_THEME_LABELS,
  type ExpenseTheme, type QualifiedExpenses, type ExpenseClass,
} from './expenses';
export { listMissingInformation, missingRequiredFields, requiredFieldsFor, type AssetCompleteness, type MissingField } from './completeness';
export { listSuppliersDeduplicated, dedupeSuppliers, supplierSource, type SupplierEntry } from './suppliers';
export { ProductRuleProvider, productRuleSources, loadProductRuleData, type ProductRuleData } from './product-rules';
export { buildSynthesisContent, boundedExcerpt, isSensitiveFact, maskedExcerpt, synthesisSourceContent, type SynthesisContentOptions } from './synthesis-content';
export { createCanonicalAccountDataRepository, canonicalAcquisitionDates, attachCanonical, readCanonicalFields } from './repository';
export { commandAssetState, unchangedSinceConfirmation } from './commands';
export { listActionables, listOpenTodos, listActiveDeadlines, type ActionableReadOptions } from './actionables';
// Lot 45 (O6) : lecture « Opération d'abord », non exclusive (CDC Opérations V1 C15).
export {
  readAssetHistory, readClaims, readPayments, readAcquisition, readContracts, findOperationDocuments, readOperationCosts, specificCostTerms, operationCostLines, summarizeOperationCosts, operationTheme,
  operationLabel, claimSourceId, parseClaimSourceId,
  type AssetHistory, type ClaimOverview, type ContractOverview, type OperationCostRead, type PaymentsRead, type AcquisitionRead, type OperationExpensePart,
} from './operations';
export {
  tryCanonicalStructured, findReadableField, isFieldQuestion, upcomingAgendaRequest, fieldAnswer,
  type CanonicalStrategy,
} from './structured-answers';

import { getCanonicalAssetState } from '@/services/canonical/asset-state';
import { readCanonicalField } from './field-reader';
import { getCanonicalDocumentState } from './document-state';
import { getCanonicalAgendaItem } from './agenda';

/**
 * `CanonicalAccountDataRepository` (T2-01) : les trois lecteurs d'objet,
 * TOUJOURS bornés au compte (premier argument).
 */
export const CanonicalAccountDataRepository = {
  getCanonicalAssetState: (accountId: number, assetId: number) => getCanonicalAssetState(assetId, accountId),
  readCanonicalField,
  getCanonicalDocumentState,
  getCanonicalAgendaItem,
};
