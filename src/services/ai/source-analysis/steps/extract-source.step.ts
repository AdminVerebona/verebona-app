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
import { normalizeTablesWithMap, cellAt } from '../../knowledge/document-tables';

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

  // Tableaux : grille explicite (lignes, colonnes, cellules vides, fusions).
  const { tables, locate } = normalizeTablesWithMap(out.tables);
  const uncertainTables = tables.filter((t) => t.uncertain);
  if (uncertainTables.length > 0) {
    warnings.push({
      code: 'TABLE_STRUCTURE_UNCERTAIN',
      message: `Structure incertaine : ${uncertainTables.map((t) => `« ${t.title ?? `tableau ${t.index + 1}`} » (${t.issues.slice(0, 2).join(' ; ') || 'signalée par l’analyse'})`).join(', ')}.`,
    });
  }


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
    tables: tables.length > 0 ? tables : undefined,
    visual: out.visual && (out.visual.summary?.trim() || out.visual.observations.length > 0)
      ? { summary: out.visual.summary?.trim() || undefined, observations: out.visual.observations }
      : undefined,
  };

  const { kept, rejected } = splitByEvidence(out.fields
    // Une valeur nulle n'est pas une information : elle n'a pas à voyager.
    .filter((f) => f.value !== null && f.value !== ''));
  if (rejected.length > 0) {
    warnings.push({
      code: 'FIELD_WITHOUT_EVIDENCE',
      message: `${rejected.length} information(s) écartée(s) faute de preuve adaptée (${rejected.slice(0, 5).join(', ')}).`,
    });
  }

  /** Une référence de cellule invalide est ignorée plutôt que d'associer au hasard. */
  const tableRef = (r?: { index: number; row: number; column: number }) => {
    if (!r) return undefined;
    const at = locate(r.index, r.row);
    if (!at || !cellAt(tables[at.index], at.row, r.column)) return undefined;
    return { index: at.index, row: at.row, column: r.column };
  };

  const extractedFields: ExtractedField[] = kept
    .map((f) => ({
      fieldKey: f.fieldKey,
      value: f.value,
      confidence: f.confidence,
      provenance: f.provenance,
      // Un extrait n'accompagne QUE ce qui a été lu (voir `splitByEvidence`).
      excerpt: f.provenance === 'TEXT_EXTRACTION' ? f.excerpt : undefined,
      visualEvidence: f.provenance === 'VISUAL_ANALYSIS' ? f.visualEvidence : undefined,
      page: f.page ?? (f.provenance === 'VISUAL_ANALYSIS' ? f.visualEvidence?.page : undefined),
      selector: f.selector,
      subject: f.subject,
      attribute: f.attribute,
      label: f.label,
      unit: f.unit,
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      section: f.section ?? (f.table ? tables[locate(f.table.index, f.table.row)?.index ?? -1]?.title ?? undefined : undefined),
      // Récurrence explicite de la source, calculée ensuite par T4.
      recurrence: f.recurrence,
      // Cellule d'origine, ramenée à la grille normalisée (fusion multi-pages).
      table: tableRef(f.table),
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

type RawField = ExtractSourceOutput['fields'][number];

/**
 * Chaque information garde la preuve de SA provenance, ou n'est pas gardée :
 *   · lue (TEXT_EXTRACTION) sans extrait littéral → écartée ;
 *   · observée (VISUAL_ANALYSIS) sans preuve visuelle → écartée ;
 *   · observée AVEC un extrait → l'extrait est retiré (il serait inventé :
 *     le modèle n'a rien lu), l'observation est conservée.
 */
export function splitByEvidence(fields: RawField[]): { kept: RawField[]; rejected: string[] } {
  const kept: RawField[] = [];
  const rejected: string[] = [];
  for (const f of fields) {
    if (f.provenance === 'VISUAL_ANALYSIS') {
      if (!f.visualEvidence?.description?.trim()) { rejected.push(f.fieldKey); continue; }
      kept.push({ ...f, excerpt: undefined });
    } else if (!f.excerpt?.trim()) {
      rejected.push(f.fieldKey);
    } else {
      kept.push({ ...f, visualEvidence: undefined });
    }
  }
  return { kept, rejected };
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
