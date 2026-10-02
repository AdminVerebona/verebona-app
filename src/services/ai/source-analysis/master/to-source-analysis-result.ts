/**
 * Adaptation master → `SourceAnalysisResult` — CDC 15 §29 (étape 11 :
 * « faire pointer les sous-opérations existantes vers le master pendant une
 * phase transitoire »).
 *
 * Le contrat historique reste celui que consomment la persistance du run, la
 * base de connaissance, le classement V2, « À traiter », T3 et T4. En
 * architecture master, il est rempli À PARTIR des faits projetés, enrichis de
 * leur cible, de leur clé canonique et de leur événement (champs optionnels
 * d'`ExtractedField`, PM-T1-PRE). Fonctions PURES.
 */
import { getField } from '@/services/canonical/registry';
import { recurrenceOf } from '../steps/build-agenda-candidates.step';
// Fait projeté → `ExtractedField` enrichi : conversion unique, portée par la persistance.
import { projectedFactToExtractedField } from '../steps/persist-evidence.step';
import type { EvidenceValue } from '../../evidence/evidence.types';
import type {
  AgendaCandidate, AiOperationTrace, AnalysisWarning, ExtractedTable, LinkCandidate,
  SourceAnalysisResult, SourceInput,
} from '../types';
import type { ProjectedFact, T1AnalyzeDocumentOutput, T1Confidence, T1Evidence } from './t1-contract';
import type { ProjectionWarning, ProjectionWarningCode } from '../projection/document-projection';
import { documentEntryOf } from '../projection/rules';

type Meta<T> = { value: T; confidence: T1Confidence; evidence: T1Evidence } | undefined;

function toEvidence<T>(m: Meta<T>): EvidenceValue<T> | undefined {
  if (!m) return undefined;
  return {
    value: m.value,
    confidence: m.confidence,
    excerpt: m.evidence?.excerpt ?? '',
    location: {
      ...(m.evidence?.page ? { page: m.evidence.page } : {}),
      ...(m.evidence?.section ? { section: m.evidence.section } : {}),
    },
  };
}

/** Confiance numérique de classification → niveau qualitatif (§8.2). */
export function qualitative(confidence: number): T1Confidence {
  return confidence >= 0.9 ? 'certain' : 'probable';
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Candidats agenda depuis les faits — UNIQUEMENT les échéances explicites
 * (DEADLINE du registre, lues, datées) du bien du document. Jamais depuis un
 * fait HISTORICAL (dpeDate, lastRevision, acquisitionDate) : c'est ce qui
 * interdit « Échéance DPE » sur une date de réalisation (P-T1-05) et une
 * prochaine date inventée depuis « Dernier entretien » (T1-06). En
 * multi-biens, seuls les faits ciblés sur le bien du document passent : les
 * échéances des autres biens ne sont jamais projetées sur lui (U8).
 */
export function agendaCandidatesFromFacts(
  facts: ProjectedFact[],
  doc: { documentAssetId: number | null; multiAsset: boolean; title?: string },
): AgendaCandidate[] {
  const out: AgendaCandidate[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (!f.canonicalKey || f.semanticEvent?.nature !== 'DEADLINE') continue;
    const def = getField(f.canonicalKey);
    if (def?.agendaEffect?.nature !== 'DEADLINE') continue;
    if (f.provenance !== 'TEXT_EXTRACTION' || !f.evidence.excerpt) continue;
    if (typeof f.value !== 'string' || !ISO.test(f.value)) continue;
    if (f.target.targetType !== 'ASSET') continue;
    const surLeBien = doc.documentAssetId !== null
      ? f.target.targetEntityId === doc.documentAssetId
      : f.target.targetEntityId === null && !doc.multiAsset;
    if (!surLeBien) continue;
    const key = `${f.value}:${f.canonicalKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const field = projectedFactToExtractedField(f);
    out.push({
      title: doc.title ? `${def.label} — ${doc.title}` : def.label,
      date: f.value,
      confidence: f.confidence,
      excerpt: f.evidence.excerpt,
      originFieldKey: f.canonicalKey,
      recurrence: recurrenceOf(field),
    });
  }
  return out;
}

/**
 * Avertissements de projection qui signalent une perte ou une requalification,
 * et leur code dans le contrat historique (`AnalysisWarningCode`) :
 *   · requalifié en connaissance générique (clé hors registre, inapplicable à
 *     la famille ou à la cible, valeur non normalisable) → FACT_REQUALIFIED_GENERIC ;
 *   · unité annoncée contredite par la valeur lue (T1-03) → UNIT_MISMATCH ;
 *   · fait, récurrence ou événement retiré par une règle → FACT_REJECTED_BY_RULE.
 */
const PERTES: Readonly<Partial<Record<ProjectionWarningCode, AnalysisWarning['code']>>> = {
  UNKNOWN_CANONICAL_KEY: 'FACT_REQUALIFIED_GENERIC',
  KEY_NOT_APPLICABLE_TO_FAMILY: 'FACT_REQUALIFIED_GENERIC',
  KEY_INPUT_ONLY: 'FACT_REQUALIFIED_GENERIC',
  CANONICAL_KEY_TARGET_MISMATCH: 'FACT_REQUALIFIED_GENERIC',
  VALUE_NOT_NORMALIZABLE: 'FACT_REQUALIFIED_GENERIC',
  UNIT_MISMATCH: 'UNIT_MISMATCH',
  SEMANTIC_EVENT_UNKNOWN: 'FACT_REJECTED_BY_RULE',
  RECURRENCE_WITHOUT_EXPLICIT_SOURCE: 'FACT_REJECTED_BY_RULE',
  FACT_REMOVED_BY_RULE: 'FACT_REJECTED_BY_RULE',
  FACT_REQUALIFIED_BY_RULE: 'FACT_REQUALIFIED_GENERIC',
  DERIVED_VALUE_UNCERTAIN: 'LINE_COUNT_UNKNOWN',
};

/**
 * Avertissements de projection → contrat historique. Le code précis de la
 * projection (et la règle appliquée) reste dans `target`
 * (`projection:CODE[:RÈGLE][:clé]`). Les informations (règle appliquée,
 * alias résolu, conversion) restent portées par les faits (`ruleCode`,
 * `origin`) et par la trace.
 */
export function toAnalysisWarnings(ws: ProjectionWarning[]): AnalysisWarning[] {
  return ws.flatMap((w) => {
    const code = PERTES[w.code];
    if (!code) return [];
    return [{
      code,
      message: w.message,
      target: `projection:${w.code}${w.ruleCode ? `:${w.ruleCode}` : ''}${w.target ? `:${w.target}` : ''}`,
    }];
  });
}

export interface MasterResultInput {
  input: SourceInput;
  groupIndices: number[];
  analysis: T1AnalyzeDocumentOutput;
  tables: ExtractedTable[];
  facts: ProjectedFact[];
  projectionWarnings: ProjectionWarning[];
  multiAsset: boolean;
  documentAssetId: number | null;
  assetCandidates: LinkCandidate[];
  roomCandidates: LinkCandidate[];
  equipmentCandidates: LinkCandidate[];
  rubric?: SourceAnalysisResult['document']['rubric'];
  warnings: AnalysisWarning[];
  trace: AiOperationTrace;
}

/** Assemble le `SourceAnalysisResult` historique depuis l'analyse master projetée. */
export function toSourceAnalysisResult(p: MasterResultInput): SourceAnalysisResult {
  const d = p.analysis.document;
  const entry = documentEntryOf(d.classification);
  const typeCode = entry?.code ?? d.classification?.canonicalType ?? null;
  const visual = p.analysis.visual;
  const title = d.title?.value;

  return {
    sourceGroup: {
      sourceIds: p.groupIndices.map((i) => p.input.sourceIds[i]),
      leadSourceId: p.input.sourceIds[p.groupIndices[0]],
    },
    document: {
      title: toEvidence(d.title),
      description: toEvidence(d.description),
      date: toEvidence(d.documentDate),
      amountCents: toEvidence(d.amountCents),
      supplier: d.supplier
        ? {
            value: { name: d.supplier.name, ...(d.supplier.siret ? { siret: d.supplier.siret } : {}), supplierId: null },
            confidence: d.supplier.confidence,
            excerpt: d.supplier.evidence?.excerpt ?? '',
            location: {},
          }
        : undefined,
      type: typeCode && d.classification
        ? {
            value: typeCode,
            confidence: qualitative(d.classification.confidence),
            excerpt: d.classification.evidence?.excerpt ?? '',
            location: {},
          }
        : undefined,
      rubric: p.rubric,
      transcription: p.analysis.transcription,
      tables: p.tables.length > 0 ? p.tables : undefined,
      visual: visual && (visual.summary?.trim() || visual.observations.length > 0)
        ? { summary: visual.summary?.trim() || undefined, observations: visual.observations }
        : undefined,
    },
    assetCandidates: p.assetCandidates,
    roomCandidates: p.roomCandidates,
    equipmentCandidates: p.equipmentCandidates,
    extractedFields: p.facts.map(projectedFactToExtractedField),
    agendaCandidates: agendaCandidatesFromFacts(p.facts, {
      documentAssetId: p.documentAssetId, multiAsset: p.multiAsset, title,
    }),
    warnings: [...p.warnings, ...toAnalysisWarnings(p.projectionWarnings)],
    operationTrace: p.trace,
  };
}
