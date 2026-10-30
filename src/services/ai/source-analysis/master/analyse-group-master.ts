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
import { guardProductIdentity } from './product-identity-guard';
import { toSourceAnalysisResult } from './to-source-analysis-result';
import type { ProjectedFact, T1AnalyzeDocumentOutput, T1FactWithRef } from './t1-contract';
import { currencyEvidenceOf, gateOperationCandidates, type AnchoredOperationCandidate } from '../operation-candidates/prepare';
import { transactionNature } from '../projection/rules';
import type { AnalysisContext, SourceAnalysisResult, SourceInput } from '../types';
import { validateValueDecisions, type PreparedValueDecision } from '../value-decisions/validate';

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
  /**
   * Lot 40 — candidats Opération (CDC Opérations V1 C3) après barrière
   * serveur, persistés avec la base de connaissance. Jamais visibles côté
   * utilisateur ; T3 les lira (lot suivant).
   */
  operationCandidates: AnchoredOperationCandidate[];
  /**
   * Lot 91D — décisions de T1 sur les valeurs significatives, VALIDÉES contre
   * les unités de la source (contrat `t1-value-decisions-v1`). Absent :
   * contrat non porté par le prompt T1 effectif, ou aucune couche A — rien
   * n'est persisté, aucune décision n'est simulée.
   */
  valueDecisions?: PreparedValueDecision[];
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
  // Lot 101A (E, F, G) : identité produit — libellé générique ≠ modèle,
  // produit connexe d'une page fournisseur jamais rattaché, modèles
  // incompatibles en conflit. Même nombre de faits, même ordre (couche A).
  const identite = guardProductIdentity(projection.facts, { mainProduct: input.webPage?.mainProduct ?? null });
  projection.facts = identite.facts;

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

  result.warnings.push(...identite.warnings);
  if (input.webPage?.relatedProductCodes.length) {
    result.warnings.push({ code: 'FACT_REJECTED_BY_RULE', message: `Page fournisseur : ${input.webPage.removedZones} zone(s) de produits connexes écartée(s) (${input.webPage.relatedProductCodes.length} code(s) produit), jamais rattachée(s).` });
  }

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

  // Lot 40 : barrière serveur des candidats Opération (règles fermées,
  // indépendantes du texte du prompt actif) — après la réparation ciblée
  // (identifiants vérifiés complétés) et le contrôle de preuve des faits.
  const a = analysed.analysis;
  const gate = gateOperationCandidates(analysed.operationCandidates ?? [], {
    hasExploitableContent: a.hasExploitableContent,
    documentTypeCode: a.document.classification?.documentTypeCode ?? null,
    verifiedIds: analysed.verifiedIds,
    capabilities: (() => {
      const caps = analysed.extraction?.capabilities ?? ctx.capabilities;
      return { rooms: caps?.rooms ?? false, equipments: caps?.equipments ?? false };
    })(),
    keptFactRefs: new Set((a.facts as T1FactWithRef[]).flatMap((f) => (f.t1FactRef ? [f.t1FactRef] : []))),
    // Lot 53D (D2, Q16) : devise et contre-valeur établies sur le document.
    currencyEvidence: currencyEvidenceOf(a),
    transactionNature: transactionNature({
      documentTypeCode: a.document.classification?.documentTypeCode ?? null,
      texts: [a.document.title?.value, a.document.amountCents?.evidence?.excerpt],
    }),
  });
  if (gate.omitted || gate.truncated) {
    console.info(`[t1-operation-candidates] fichier ${input.sourceIds[groupIndices[0]]} : ${gate.candidates.length} candidat(s) retenu(s), `
      + `${gate.omitted} non établi(s) sans motif omis, ${gate.truncated} au-delà de 20.`);
  }

  // Lot 91D : décisions sur les valeurs significatives — exploitées SEULEMENT si le prompt T1 effectif porte le
  // contrat (marqueur) et que la version qui a répondu est bien celle-là ; validées contre les unités de la source.
  let valueDecisions: PreparedValueDecision[] | undefined;
  if (analysed.valueDecisions && sourceLayer) {
    const { valueDecisionsCapability } = await import('../value-decisions/contract');
    const cap = await valueDecisionsCapability();
    if (cap.carried && (cap.version === null || cap.version === analysed.promptVersion)) {
      valueDecisions = validateValueDecisions(analysed.valueDecisions, {
        units: sourceLayer.units,
        keptFactRefs: new Set((a.facts as T1FactWithRef[]).flatMap((f) => (f.t1FactRef ? [f.t1FactRef] : []))),
        candidateKeys: new Set(gate.candidates.map((c) => c.candidateKey)),
      });
    } else if (analysed.valueDecisions.length > 0) {
      console.info(`[t1-value-decisions] fichier ${input.sourceIds[groupIndices[0]]} : ${analysed.valueDecisions.length} décision(s) ignorée(s) `
        + `(contrat ${cap.reason}${cap.carried ? ', version du prompt différente' : ''}).`);
    }
  }

  // Lot 97A : période facturée et mois principal (contrat t1-billing-period-v1, demande 87D) — conservés avec le
  // résultat SEULEMENT si le prompt T1 effectif porte le contrat et que c'est cette version qui a répondu.
  if (a.document.billingPeriod) {
    const { billingPeriodCapability, persistedBillingPeriod } = await import('../billing-period/contract');
    const cap = await billingPeriodCapability();
    const bp = persistedBillingPeriod(a.document.billingPeriod, cap, analysed.promptVersion);
    if (bp) result.document.billingPeriod = bp;
    else console.info(`[t1-billing-period] fichier ${input.sourceIds[groupIndices[0]]} : période facturée ignorée (contrat ${cap.reason}${cap.carried ? ', version du prompt différente' : ''}).`);
  }

  return {
    result, facts: projection.facts, projection, documentAssetId: analysed.documentAssetId,
    promptVersion: analysed.promptVersion,
    ...(sourceLayer ? { sourceLayer } : {}),
    operationCandidates: gate.candidates,
    ...(valueDecisions ? { valueDecisions } : {}),
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
        // Lot 86E : la nature identifiée (`canonicalType`) complète le Type enregistré.
        { rubricCode: c.rubricCode, documentTypeCode: c.documentTypeCode ?? null, canonicalType: c.canonicalType ?? null, confidence: c.confidence, excerpt: c.evidence?.excerpt ?? '' },
        applicable,
        families,
      )
    : deduceFromType(c.documentTypeCode ?? c.canonicalType);
  if (!proposal) return undefined;
  return { ...proposal, promptVersion };
}
