/**
 * Étapes 5 à 7 — extraction du contenu et des informations structurées
 * (opération `extract_source`).
 *
 * ⚠️ DIFFÉRENCE MAJEURE AVEC L'EXISTANT : le prompt ne comporte plus la règle
 * « ne pas proposer un champ déjà renseigné » (ancienne règle R3 de
 * `asset_suggest_v1.txt`), interdite par le CDC §4.2.5. L'analyse extrait tout
 * ce qu'elle trouve, AVEC SA PREUVE ; c'est le moteur de réconciliation qui
 * décide seul d'appliquer, de conserver ou de créer un conflit.
 *
 * Corollaire : cette étape n'écrit RIEN dans la fiche du bien.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { ExtractSourceOutput } from '../schemas';
import type {
  SourceInput, AnalysisContext, ExtractedField, AnalysisWarning,
  SourceAnalysisResult, AiOperationTrace,
} from '../types';
import type { EvidenceValue } from '../../evidence/evidence.types';
import { emptyTrace, mergeTrace } from '../trace';

export interface ExtractSourceResult {
  document: SourceAnalysisResult['document'];
  extractedFields: ExtractedField[];
  warnings: AnalysisWarning[];
  trace: AiOperationTrace;
}

export async function extractSource(
  input: SourceInput,
  groupIndices: number[],
  ctx: AnalysisContext,
): Promise<ExtractSourceResult> {
  const warnings: AnalysisWarning[] = [];

  const res = await AiGateway.execute({
    useCaseCode: 'SOURCE_ANALYSIS',
    operationCode: 'extract_source',
    accountId: input.accountId,
    userId: input.userId,
    sourceIds: groupIndices.map((i) => input.sourceIds[i]),
    promptVariables: {
      // Contexte minimal : seulement ce qui sert à situer le document (§5.6).
      ASSET_CONTEXT: buildAssetContext(ctx),
      EXISTING_TITLES: ctx.existingTitles.slice(0, 50).join('\n'),
      // Pour un lien web, le contenu est déjà extrait par l'adaptateur.
      EXTRACTED_CONTENT: input.extractedContent ?? '',
      SOURCE_KIND: input.sourceType === 'web_link' ? 'page web' : 'document',
      // ══════════════════════════════════════════════════════════════════
      // VOCABULAIRE DES CHAMPS — VIDE EN PRODUCTION, POUR L'INSTANT
      //
      // Le prompt accepte une liste de clés à employer dans `fieldKey`. Le
      // corpus de mesure la renseigne : sans elle, le modèle nomme
      // librement, et les clés attendues ne se rencontrent presque jamais —
      // 6 champs corrects sur 83 lors de la première campagne.
      //
      // Ici elle reste vide, faute de référentiel de champs par type de
      // document. La règle R7bis du prompt le prévoit : sans liste, le
      // modèle nomme comme avant. Aucun changement de comportement.
      //
      // Le jour où ce référentiel existera, c'est ici qu'il se branchera —
      // et le classement en tirera le même bénéfice que la mesure.
      // ══════════════════════════════════════════════════════════════════
      EXPECTED_FIELDS: '',
    },
    attachments: buildAttachments(input, groupIndices),
    outputSchema: ExtractSourceOutput,
    sourceVersion: input.sourceVersion,
  });

  const out = res.data;

  if (!out.hasExploitableContent) {
    warnings.push({
      code: 'NO_EXPLOITABLE_CONTENT',
      message: "La source ne contient aucune information exploitable.",
    });
  }

  const document: SourceAnalysisResult['document'] = {
    title: toEvidence(out.title),
    description: toEvidence(out.description),
    date: toEvidence(out.documentDate),
    amountCents: toEvidence(out.amountCents),
    supplier: out.supplier
      ? {
          value: { name: out.supplier.name, siret: out.supplier.siret, supplierId: null },
          confidence: out.supplier.confidence,
          excerpt: out.supplier.excerpt,
          location: {},
        }
      : undefined,
    transcription: out.transcription,
  };

  const extractedFields: ExtractedField[] = out.fields
    // Une valeur nulle n'est pas une information : elle n'a pas à voyager.
    .filter((f) => f.value !== null && f.value !== '')
    .map((f) => ({
      fieldKey: f.fieldKey,
      value: f.value,
      confidence: f.confidence,
      excerpt: f.excerpt,
      page: f.page,
      selector: f.selector,
    }));

  const lowConfidenceRatio = ratioOfLowConfidence(extractedFields);
  if (extractedFields.length >= 5 && lowConfidenceRatio > 0.6) {
    warnings.push({
      code: 'LOW_CONFIDENCE_OVERALL',
      message: `${Math.round(lowConfidenceRatio * 100)} % des champs extraits sont incertains.`,
    });
  }

  return {
    document,
    extractedFields,
    warnings,
    trace: mergeTrace(emptyTrace(), res, 'extract_source'),
  };
}

function toEvidence<T>(
  v: { value: T; confidence: 'certain' | 'probable' | 'conflictual'; excerpt: string } | undefined,
): EvidenceValue<T> | undefined {
  if (!v) return undefined;
  return { value: v.value, confidence: v.confidence, excerpt: v.excerpt, location: {} };
}

function ratioOfLowConfidence(fields: ExtractedField[]): number {
  if (fields.length === 0) return 0;
  const low = fields.filter((f) => f.confidence !== 'certain').length;
  return low / fields.length;
}

/**
 * Contexte du compte transmis au modèle : identifiants et libellés seulement.
 * Jamais de sérialisation complète des enregistrements (§5.6, anti-pattern).
 */
function buildAssetContext(ctx: AnalysisContext): string {
  if (ctx.linkedAssetId) {
    const a = ctx.assets.find((x) => x.id === ctx.linkedAssetId);
    return a ? `Bien déjà rattaché : [id:${a.id}] ${a.name}` : '';
  }
  return ctx.assets
    .slice(0, 60)
    .map((a) => `[id:${a.id}] ${a.name}${a.subtype ? ` (${a.subtype})` : ''}`)
    .join('\n');
}

function buildAttachments(input: SourceInput, groupIndices: number[]) {
  if (!input.contentUrls) return [];
  return groupIndices
    .map((i) => ({
      url: input.contentUrls![i],
      mimeType: input.mimeTypes[i] ?? 'application/pdf',
      displayName: input.displayNames[i],
    }))
    .filter((a) => Boolean(a.url));
}
