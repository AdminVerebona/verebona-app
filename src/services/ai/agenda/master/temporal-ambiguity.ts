/**
 * T4 master — branche TEMPORAL_AMBIGUITY (CDC 15 §26, T1 à T4 ; reliquat R5,
 * lot 18).
 *
 * Appelée par T4 (`processAgendaCandidates`) quand `detectTemporalAmbiguity`
 * signale une date incertaine (lecture jj/mm ↔ mm/jj, mention relative),
 * SEULEMENT si T4 est en architecture `master` et `AI_T4_EFFECTS=enabled`.
 * Candidat certain de la liste fournie → appliqué ; abstention, hors liste
 * ou échec → carte AGENDA-PROPOSAL avec les dates possibles, sans création.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled } from '../../queue/execution-control';
import { T4TemporalAmbiguityOutput as Schema, closedWorldTemporal, type T4TemporalAmbiguityOutput } from './t4-contract';

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

/**
 * Appel de la branche. Échec du modèle : `null` (jamais d'exception, sauf
 * interruption de la file) — l'appelant propose alors les dates.
 */
export async function resolveTemporalAmbiguityMaster(
  context: Record<string, unknown>,
  candidates: TemporalCandidate[],
  ctx: { accountId: number; userId?: number; sourceFileId?: number | null },
): Promise<{ chosen: TemporalCandidate | null; warning: string | null }> {
  try {
    const res = await AiGateway.execute({
      useCaseCode: 'AGENDA_INTELLIGENCE',
      operationCode: 't4_temporal_ambiguity',
      accountId: ctx.accountId,
      userId: ctx.userId,
      sourceIds: ctx.sourceFileId ? [ctx.sourceFileId] : undefined,
      promptVariables: temporalAmbiguityVariables(context, candidates),
      outputSchema: Schema,
    });
    const r = translateTemporalAmbiguity(res.data, candidates);
    if (r.warning) console.warn(`[t4_temporal_ambiguity] ${r.warning}`);
    return r;
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.warn('[t4_temporal_ambiguity] arbitrage modèle indisponible :', (e as Error).message);
    return { chosen: null, warning: 'MODEL_UNAVAILABLE' };
  }
}
