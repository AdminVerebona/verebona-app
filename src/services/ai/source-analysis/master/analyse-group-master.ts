/**
 * Chemin master d'un groupe de sources — CDC 15 §23, §29 ; T1-01 à T1-08.
 *
 *   ANALYZE_DOCUMENT (un appel) → contrôle de preuve et identifiants →
 *   projection déterministe → classement V2 → `SourceAnalysisResult`.
 *
 * Renvoie AUSSI les faits projetés : c'est eux que la persistance écrit sur
 * leur cible (`persistProjectedFacts`), et non plus `extractedFields` sur un
 * seul bien.
 */
import { toAssetFamily, type AssetFamily } from '@/services/canonical/registry';
import { getVisibleRubrics } from '@/lib/referential/v2';
import { analyzeDocument, type AnalyzeDocumentOptions } from '../steps/analyze-document.step';
import { deduceFromType, loadAssetFamilies, validateProposal } from '../steps/classify-rubric.step';
import { projectDocumentFacts, type DocumentProjection } from '../projection/document-projection';
import { combineTraces } from '../trace';
import { toSourceAnalysisResult } from './to-source-analysis-result';
import type { ProjectedFact, T1AnalyzeDocumentOutput } from './t1-contract';
import type { AnalysisContext, SourceAnalysisResult, SourceInput } from '../types';

export interface MasterGroupAnalysis {
  result: SourceAnalysisResult;
  facts: ProjectedFact[];
  projection: DocumentProjection;
  /** Bien du document retenu par l'analyse (connu ou unique candidat certain). */
  documentAssetId: number | null;
  /** Version réellement résolue du master (fichier ou version de configuration). */
  promptVersion: string;
}

export async function analyseGroupWithMaster(
  input: SourceInput,
  groupIndices: number[],
  ctx: AnalysisContext,
  groupTrace: SourceAnalysisResult['operationTrace'],
  opts: AnalyzeDocumentOptions = {},
): Promise<MasterGroupAnalysis> {
  const analysed = await analyzeDocument(input, groupIndices, ctx, opts);

  const assetFamilies = new Map<number, AssetFamily | undefined>(
    ctx.assets.map((a) => [a.id, toAssetFamily(a.category)]),
  );
  const projection = projectDocumentFacts(analysed.analysis, {
    knownAssetId: ctx.linkedAssetId ?? null,
    documentAssetId: analysed.documentAssetId,
    assetFamilies,
    verifiedIds: analysed.verifiedIds,
  });

  const assetIds = analysed.assetCandidates
    .filter((c) => c.verified && c.entityId !== null)
    .map((c) => c.entityId as number);
  const rubric = await rubricOf(analysed.analysis, assetIds, analysed.promptVersion).catch((e) => {
    // Comme au chemin historique : le classement V2 ne compromet jamais l'analyse.
    console.error('[t1-master] classement V2 indisponible :', (e as Error).message);
    return undefined;
  });

  const result = toSourceAnalysisResult({
    input,
    groupIndices,
    analysis: analysed.analysis,
    tables: analysed.tables,
    facts: projection.facts,
    projectionWarnings: projection.warnings,
    multiAsset: projection.multiAsset,
    documentAssetId: analysed.documentAssetId,
    assetCandidates: analysed.assetCandidates,
    roomCandidates: analysed.roomCandidates,
    equipmentCandidates: analysed.equipmentCandidates,
    rubric,
    warnings: analysed.warnings,
    trace: combineTraces(groupTrace, analysed.trace),
  });

  return {
    result, facts: projection.facts, projection, documentAssetId: analysed.documentAssetId,
    promptVersion: analysed.promptVersion,
  };
}

/**
 * Classement V2 proposé par le master, soumis au MÊME garde-fou que l'étape
 * `classify_rubric` (Rubrique hors périmètre, Type « Autre », Type incohérent
 * ou inapplicable écartés), puis déduction depuis le Type à défaut (§2.2).
 */
async function rubricOf(
  analysis: T1AnalyzeDocumentOutput,
  assetIds: number[],
  promptVersion: string,
): Promise<SourceAnalysisResult['document']['rubric']> {
  const c = analysis.document.classification;
  if (!c) return undefined;
  const families = await loadAssetFamilies(assetIds);
  const applicable = getVisibleRubrics({ families, hasRentedAsset: true, hasRentalDocuments: true }).map((r) => r.code);
  const proposal = c.rubricCode
    ? validateProposal(
        { rubricCode: c.rubricCode, documentTypeCode: c.documentTypeCode ?? null, confidence: c.confidence, excerpt: c.evidence?.excerpt ?? '' },
        applicable,
        families,
      )
    : deduceFromType(c.documentTypeCode ?? c.canonicalType);
  if (!proposal) return undefined;
  return { ...proposal, promptVersion };
}
