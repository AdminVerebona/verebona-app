/**
 * T4 master — branche VERIFY_COMPLETION (CDC 15 §26, T4-12 à T4-14, V1 à V4).
 *
 * Appelée seulement quand la décision déterministe (`decideCompletion`)
 * reste `unknown` (forme de preuve à lire, preuve non datée) ET que T4 est
 * en architecture `master`. Le serveur garde le dernier mot :
 *   · la fenêtre d'occurrence calculée par le code prime — si la preuve est
 *     datée hors fenêtre, aucune réponse du modèle ne clôt l'échéance ;
 *   · `insufficient` ⇒ not_proven (jamais « non réalisé ») ;
 *   · `proves_not_completed` ⇒ not_completed, PROPOSÉ, jamais écrit ;
 *   · `conflictual` ⇒ unknown.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled } from '../../queue/execution-control';
import { resolveDocumentType } from '@/services/canonical/registry';
import type { ExistingAgendaItem } from '../types';
import {
  matchOccurrence, OCCURRENCE_EXACT_DAYS, NON_RECURRING_EARLY_DAYS,
  type CompletionDecision, type CompletionEvidence,
} from '../status-reconciler';
import { T4VerifyCompletionOutput, type T4VerifyCompletionOutput as Out } from './t4-contract';

export function verifyCompletionVariables(
  item: ExistingAgendaItem, evidence: CompletionEvidence, det: CompletionDecision,
): Record<string, unknown> {
  const entry = resolveDocumentType(evidence.documentType);
  return {
    AGENDA_ITEM: {
      title: item.title,
      date: item.date,
      businessType: item.businessType ?? null,
      recurrence: item.recurrence ?? null,
      // Fenêtre serveur (T4-14), transmise en donnée (U4).
      occurrenceWindow: item.recurrence
        ? { rule: 'occurrence la plus proche : ± demi-période', exactDays: OCCURRENCE_EXACT_DAYS }
        : { rule: `de ${NON_RECURRING_EARLY_DAYS} jours avant l'échéance à toute date après`, exactDays: OCCURRENCE_EXACT_DAYS },
    },
    DOCUMENT_TYPE: entry
      ? { code: entry.code, label: entry.label, completionProofs: det.applicableProofs ?? entry.completionProofs }
      : { code: evidence.documentType ?? null, label: null, completionProofs: [] },
    EVIDENCE: {
      excerpt: evidence.excerpt.slice(0, 1000),
      documentDate: evidence.documentDate ? evidence.documentDate.toISOString().slice(0, 10) : null,
      occurrenceDate: evidence.occurrenceDate ? evidence.occurrenceDate.toISOString().slice(0, 10) : null,
    },
    EVENT_CONTEXT: null, EVENT_CATALOG: null, TEMPORAL_CONTEXT: null, TEMPORAL_CANDIDATES: null,
  };
}

/** Traduction pure, avec contrôle serveur de l'occurrence. */
export function translateVerifyCompletion(
  item: ExistingAgendaItem, evidence: CompletionEvidence, det: CompletionDecision, out: Out,
): CompletionDecision {
  const base = { applicableProofs: det.applicableProofs, needsModel: false };
  const serveur = matchOccurrence(item.date, evidence.occurrenceDate ?? evidence.documentDate, item.recurrence);
  const keep = (status: CompletionDecision['status'], reasonCode: CompletionDecision['reasonCode'], occurrenceMatch = out.occurrenceMatch): CompletionDecision => ({
    ...base, status, decision: 'keep', occurrenceMatch, reasonCode, reason: out.reason,
  });

  switch (out.evidenceStatus) {
    case 'insufficient':
      return keep('not_proven', 'MODEL_INSUFFICIENT');
    case 'conflictual':
      return keep('unknown', 'MODEL_CONFLICTUAL');
    case 'proves_not_completed':
      return { ...keep('not_completed', 'MODEL_NOT_COMPLETED'), decision: 'propose_not_done' };
    case 'proves_completed': {
      if (serveur === 'none' || out.occurrenceMatch === 'none') return keep('not_proven', 'MODEL_OCCURRENCE_MISMATCH', 'none');
      if (out.occurrenceMatch === 'ambiguous') return keep('unknown', 'MODEL_OCCURRENCE_AMBIGUOUS', 'ambiguous');
      const certain = out.confidence === 'certain' && evidence.confidence === 'certain' && serveur !== 'ambiguous';
      return {
        ...base, status: 'completed', decision: certain ? 'mark_done' : 'propose_done',
        occurrenceMatch: serveur === 'ambiguous' ? out.occurrenceMatch : serveur,
        reasonCode: 'COMPLETION_PROVEN', reason: out.reason,
      };
    }
  }
}

/** Vérification par le master. Échec : décision déterministe conservée (unknown). */
export async function verifyCompletionMaster(
  item: ExistingAgendaItem, evidence: CompletionEvidence, det: CompletionDecision,
  ctx: { accountId: number; userId?: number; sourceFileId?: number | null },
): Promise<CompletionDecision> {
  try {
    const res = await AiGateway.execute({
      useCaseCode: 'AGENDA_INTELLIGENCE',
      operationCode: 't4_verify_completion',
      accountId: ctx.accountId,
      userId: ctx.userId,
      sourceIds: ctx.sourceFileId ? [ctx.sourceFileId] : undefined,
      promptVariables: verifyCompletionVariables(item, evidence, det),
      outputSchema: T4VerifyCompletionOutput,
    });
    return translateVerifyCompletion(item, evidence, det, res.data);
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.warn('[t4_verify_completion] vérification modèle indisponible :', (e as Error).message);
    return det;
  }
}
