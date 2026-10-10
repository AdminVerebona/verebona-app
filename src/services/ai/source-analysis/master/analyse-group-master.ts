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
import { analyzeDocument, callAnalyzeDocument, verifyAll } from '../steps/analyze-document.step';
import { completeT1Extraction, finalizeSourceLayer } from '../source-units/complete-extraction';
import type { SourceLayer } from '../source-units/types';
import { deduceFromType, loadAssetFamilies, validateProposal } from './rubric-rules';
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
  /**
   * Lot 34F — couche A (unités de la source, couverture, faits non résolus,
   * rapport de complétude), persistée avec la base de connaissance.
   * Absente pour une analyse sans matière (étape simulée en test).
   */
  sourceLayer?: SourceLayer;
}

export async function analyseGroupWithMaster(
  input: SourceInput,
  groupIndices: number[],
  ctx: AnalysisContext,
  groupTrace: SourceAnalysisResult['operationTrace'],
): Promise<MasterGroupAnalysis> {
  const analysed = await analyzeDocument(input, groupIndices, ctx);

  // Lot 34F : couche A, contrôle de couverture et réparation CIBLÉE (bornée,
  // jamais systématique) — avant la projection, qui voit les faits réparés.
  const draft = await completeT1Extraction({
    input, groupIndices, ctx, analysed,
    call: (c) => callAnalyzeDocument(c),
    verifyTargets: async (facts) => {
      const v = await verifyAll({ ...analysed.analysis, entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false } }, facts, input.accountId);
      return { verifiedIds: v.verifiedIds, warnings: v.warnings };
    },
  });

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
    // Le classement V2 ne compromet jamais l'analyse.
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

  // Lot 34F : provenance des faits (sourceUnitIds), rapport de complétude,
  // anomalies fonctionnelles (SOURCE_UNIT_FAILED, COVERAGE_INCOMPLETE).
  let sourceLayer: SourceLayer | undefined;
  if (draft) {
    const fin = finalizeSourceLayer(draft, {
      analysisFacts: analysed.analysis.facts,
      projected: projection.facts,
      projectionWarnings: projection.warnings,
      warningCodes: result.warnings.map((w) => w.code),
    });
    sourceLayer = fin.layer;
    result.warnings.push(...fin.warnings);
    result.extractedFields.forEach((f, i) => {
      const ids = projection.facts[i]?.sourceUnitIds;
      if (ids?.length) f.sourceUnitIds = ids;
    });
  }

  return {
    result, facts: projection.facts, projection, documentAssetId: analysed.documentAssetId,
    promptVersion: analysed.promptVersion,
    ...(sourceLayer ? { sourceLayer } : {}),
  };
}

/**
 * Classement V2 proposé par le master, soumis au garde-fou
 * `validateProposal` (Rubrique hors périmètre, Type « Autre », Type incohérent
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
