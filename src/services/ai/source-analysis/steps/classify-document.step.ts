/**
 * Étape 6 — classification documentaire (opération `classify_document`).
 *
 * Déterminisme avant IA (CDC §3.2) : la table `document_taxonomy_mappings`
 * contient déjà des correspondances libellé → code canonique. Lorsqu'une
 * correspondance exacte existe, aucun appel modèle n'est émis.
 */
import { db } from '@/db';
import { documentTaxonomyMappings } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { AiGateway } from '../../gateway/ai-gateway';
import { ClassifyDocumentOutput } from '../schemas';
import type { SourceInput, AiOperationTrace } from '../types';
import type { EvidenceValue } from '../../evidence/evidence.types';
import { emptyTrace, mergeTrace } from '../trace';

export interface ClassifyDocumentResult {
  type?: EvidenceValue<string>;
  trace: AiOperationTrace;
}

export async function classifyDocument(
  input: SourceInput,
  groupIndices: number[],
  hints: { title?: string; supplierName?: string; extractedText?: string },
): Promise<ClassifyDocumentResult> {
  // 1. Correspondance déterministe sur le titre retenu.
  if (hints.title) {
    const canonical = await lookupCanonicalType(hints.title);
    if (canonical) {
      return {
        type: {
          value: canonical,
          confidence: 'certain',
          excerpt: hints.title,
          location: {},
        },
        trace: emptyTrace(),
      };
    }
  }

  // 2. Appel modèle uniquement si la règle n'a pas tranché.
  const res = await AiGateway.execute({
    useCaseCode: 'SOURCE_ANALYSIS',
    operationCode: 'classify_document',
    accountId: input.accountId,
    userId: input.userId,
    sourceIds: groupIndices.map((i) => input.sourceIds[i]),
    promptVariables: {
      TITLE: hints.title ?? '',
      SUPPLIER: hints.supplierName ?? '',
      CONTENT_SAMPLE: (hints.extractedText ?? input.extractedContent ?? '').slice(0, 4000),
    },
    outputSchema: ClassifyDocumentOutput,
    sourceVersion: input.sourceVersion,
  });

  return {
    type: {
      value: res.data.documentType,
      confidence: res.data.confidence,
      excerpt: res.data.excerpt,
      location: {},
    },
    trace: mergeTrace(emptyTrace(), res, 'classify_document'),
  };
}

async function lookupCanonicalType(rawLabel: string): Promise<string | null> {
  const [row] = await db
    .select({ canonicalCode: documentTaxonomyMappings.canonicalCode })
    .from(documentTaxonomyMappings)
    .where(and(
      eq(documentTaxonomyMappings.mappingType, 'function_code'),
      eq(documentTaxonomyMappings.rawLabel, rawLabel.trim().toLowerCase()),
      eq(documentTaxonomyMappings.status, 'active'),
    ))
    .limit(1);
  return row?.canonicalCode ?? null;
}
