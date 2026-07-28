/**
 * Étape 9 — production des preuves par champ (CDC §4.1.7, §5.4).
 *
 * « Chaque valeur extraite doit comporter une preuve exploitable. »
 *
 * Les preuves sont écrites AVANT toute décision de réconciliation : elles
 * constituent le matériau du moteur de l'usage 2, qui ne relit jamais le
 * document lui-même (§5.6 : « Ne pas réenvoyer un document au modèle lorsque
 * son analyse structurée et ses preuves suffisent »).
 */
import { recordEvidence } from '../../evidence/field-evidence.service';
import { computeAuthorityScore } from '../../evidence/authority-score';
import type { ExtractedField, SourceInput, AiOperationTrace } from '../types';

export interface PersistEvidenceInput {
  input: SourceInput;
  leadSourceId: number;
  assetId: number;
  fields: ExtractedField[];
  documentType?: string;
  documentDate?: string;
  trace: AiOperationTrace;
}

/** Renvoie les identifiants de preuve créés, indexés par champ. */
export async function persistEvidence(p: PersistEvidenceInput): Promise<Map<string, number>> {
  const byField = new Map<string, number>();
  if (!p.assetId) return byField;

  const authorityScore = computeAuthorityScore({
    documentType: p.documentType,
    documentDate: p.documentDate ? new Date(p.documentDate) : null,
  });

  for (const field of p.fields) {
    try {
      const evidenceId = await recordEvidence({
        accountId: p.input.accountId,
        assetId: p.assetId,
        fieldKey: field.fieldKey,
        value: field.value,
        normalizedValue: field.normalizedValue ?? String(field.value),
        sourceType: p.input.sourceType === 'web_link' ? 'web_link' : 'document',
        sourceId: p.leadSourceId,
        sourceVersion: p.input.sourceVersion,
        location: { page: field.page, selector: field.selector },
        excerpt: field.excerpt,
        documentType: p.documentType,
        documentDate: p.documentDate ? new Date(p.documentDate) : null,
        provider: 'gemini',
        model: p.trace.models[0],
        promptVersion: 'extract_source_v2',
        confidence: field.confidence,
        authorityScore,
        operationTraceId: p.trace.traceIds[0],
      });
      byField.set(field.fieldKey, evidenceId);
    } catch (e) {
      // Une preuve manquante dégrade la réconciliation mais ne doit pas faire
      // échouer l'analyse du document (§11.4).
      console.error(`[persist-evidence] champ ${field.fieldKey} :`, (e as Error).message);
    }
  }

  return byField;
}
