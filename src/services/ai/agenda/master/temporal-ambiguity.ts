/**
 * T4 master — branche TEMPORAL_AMBIGUITY (CDC 15 §26, T1 à T4).
 *
 * Contrat et traduction prêts ; AUCUN appelant au lot 14 : les ambiguïtés
 * temporelles (date de réalisation vs expiration, récurrence non démontrée)
 * sont aujourd'hui tranchées par les règles (`date-interpreter`,
 * `recurrence`) ou proposées à l'utilisateur. La branche existe pour que le
 * master soit complet (une entrée prompt par traitement, §29.1).
 */
import { closedWorldTemporal, type T4TemporalAmbiguityOutput } from './t4-contract';

export interface TemporalCandidate { candidateId: number; date: string; interpretation: string }

/** Variables du master (candidats triés par identifiant : ordre neutre). */
export function temporalAmbiguityVariables(context: Record<string, unknown>, candidates: TemporalCandidate[]): Record<string, unknown> {
  return {
    TEMPORAL_CONTEXT: context,
    TEMPORAL_CANDIDATES: [...candidates].sort((a, b) => a.candidateId - b.candidateId),
    EVENT_CONTEXT: null, EVENT_CATALOG: null, EVIDENCE: null, AGENDA_ITEM: null, DOCUMENT_TYPE: null,
  };
}

/** Candidat retenu, ou `null` (abstention, hors liste, confiance ambiguë). */
export function translateTemporalAmbiguity(
  out: T4TemporalAmbiguityOutput, candidates: TemporalCandidate[],
): { chosen: TemporalCandidate | null; warning: string | null } {
  const { output, warning } = closedWorldTemporal(out, new Set(candidates.map((c) => c.candidateId)));
  if (output.decision !== 'choose' || output.confidence !== 'probable') return { chosen: null, warning };
  return { chosen: candidates.find((c) => c.candidateId === output.candidateId) ?? null, warning };
}
