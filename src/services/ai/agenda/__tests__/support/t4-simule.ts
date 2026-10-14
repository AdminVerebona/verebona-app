/**
 * Lot 54 — T4 SIMULÉ pour les tests du moteur Agenda (aucun appel réseau).
 *
 * Depuis le lot 54, chaque candidat documentaire automatique passe par la
 * décision T4 (CLASSIFY_EVENT). Les tests antérieurs, qui portent sur la
 * déduplication, l'autorisation de la source, les récurrences ou la
 * sémantique recopiée, injectent ce T4 « bien élevé » : il ACCEPTE
 * l'événement, reprend la catégorie de l'indice déterministe transmis (sinon
 * `action`) et accepte la récurrence quand le serveur en envisage une — soit
 * le comportement antérieur au lot 54. Les tests du lot 54 injectent leurs
 * propres décisions.
 */
import type { ClassifyEventContext, T4EventDecision } from '../../master/classify-event';
import type { AgendaClassificationInput } from '../../types';

export async function t4Simule(_input: AgendaClassificationInput, ctx: ClassifyEventContext): Promise<T4EventDecision> {
  const category = (ctx.ruleHint?.category as 'action' | 'information' | undefined) ?? 'action';
  return {
    agendaDecision: 'accept',
    recurrenceDecision: ctx.recurrenceCandidate ? 'accept' : 'not_applicable',
    classification: { category, confidence: ctx.ruleHint ? 'certain' : 'probable', source: 'model', businessType: null, reason: 'T4 simulé' },
    reason: 'T4 simulé', recurrenceReason: ctx.recurrenceCandidate ? 'T4 simulé' : null, outcome: 'model_v2', warnings: [],
  };
}
