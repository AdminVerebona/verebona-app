/**
 * Lot 111I — rattachement multiple d'un document (biens, pièces, équipements).
 * Source canonique : `document_asset_links` ; colonnes historiques = principal dérivé.
 * Voir `plan.ts` (règles pures) et `service.ts` (lecture / écriture bornées au compte).
 */
export * from './plan';
export {
  readDocumentTargets, listTargetOptions, applyDocumentTargets, planDocumentTargets, TARGET_OPTIONS_MAX_ASSETS,
  type DocumentTargetItem, type DocumentTargetsView, type TargetOptionGroup, type ApplyTargetsInput, type ApplyTargetsResult,
  type TargetsExecutor,
} from './service';
