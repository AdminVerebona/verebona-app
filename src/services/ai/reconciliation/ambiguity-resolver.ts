/**
 * Arbitrage IA ciblé — opération `resolve_ambiguity`, CDC §4.2.8 étape 7.
 *
 * « LLM uniquement lorsque la décision reste ambiguë. »
 *
 * Ce module n'est appelé que sur les décisions `request_ai_review`, c'est-à-dire
 * après épuisement des six étapes déterministes. Il reçoit les preuves déjà
 * extraites — jamais le document — conformément au §5.6.
 *
 * Le modèle ne peut que CHOISIR parmi les preuves fournies ou s'abstenir. Il ne
 * peut ni proposer une valeur nouvelle, ni écrire.
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import type { ReconciliationDecision, EvidenceCandidate } from './types';

const ResolveAmbiguityOutput = z.object({
  /** Identifiant de la preuve retenue, ou null si le modèle s'abstient. */
  chosenEvidenceId: z.number().int().positive().nullable(),
  confidence: z.enum(['certain', 'probable', 'conflictual']),
  reason: z.string().min(1).max(400),
});

export interface ResolveAmbiguityInput {
  accountId: number;
  assetId: number;
  decision: ReconciliationDecision;
  candidates: EvidenceCandidate[];
  currentValue: unknown;
  currentOrigin: string;
}

/**
 * Renvoie une décision révisée. En cas d'échec, d'abstention ou de réponse
 * incohérente, la décision devient un conflit : l'utilisateur tranche. Le repli
 * n'est jamais une application automatique.
 */
export async function resolveAmbiguity(
  input: ResolveAmbiguityInput,
): Promise<ReconciliationDecision> {
  const { decision, candidates } = input;
  const allowedIds = new Set(candidates.map((c) => c.evidenceId));

  try {
    const res = await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION',
      operationCode: 'resolve_ambiguity',
      accountId: input.accountId,
      promptVariables: {
        FIELD: decision.fieldKey,
        CURRENT_VALUE: String(input.currentValue ?? '(vide)'),
        CURRENT_ORIGIN: input.currentOrigin,
        // Seules les preuves circulent : ni le document, ni la fiche complète.
        EVIDENCES: candidates.map((c) =>
          `[id:${c.evidenceId}] valeur="${String(c.value)}" ` +
          `type=${c.documentType ?? 'inconnu'} date=${c.documentDate?.toISOString().slice(0, 10) ?? 'inconnue'} ` +
          `autorité=${c.authorityScore} extrait="${c.excerpt.slice(0, 300)}"`,
        ).join('\n'),
      },
      outputSchema: ResolveAmbiguityOutput,
    });

    const chosenId = res.data.chosenEvidenceId;

    // Abstention explicite : comportement attendu, pas un échec.
    if (chosenId === null) {
      return { ...decision, action: 'create_conflict',
        reasonCode: 'AMBIGUOUS_EVIDENCE', deterministic: false };
    }

    // Un identifiant hors des preuves fournies est une hallucination : refusé.
    if (!allowedIds.has(chosenId)) {
      console.warn(`[resolve_ambiguity] preuve ${chosenId} hors périmètre — arbitrage utilisateur`);
      return { ...decision, action: 'create_conflict',
        reasonCode: 'AMBIGUOUS_EVIDENCE', deterministic: false };
    }

    const chosen = candidates.find((c) => c.evidenceId === chosenId)!;

    // Le modèle n'obtient jamais mieux que « probable » : une valeur appliquée
    // automatiquement sur avis d'un modèle resterait invérifiable. Le §4.2.6
    // exige `certain` pour les champs critiques, ce qui les exclut de fait.
    if (res.data.confidence !== 'certain') {
      return {
        ...decision, action: 'create_conflict', proposedValue: chosen.value,
        reasonCode: 'AMBIGUOUS_EVIDENCE', confidence: res.data.confidence,
        evidenceIds: [chosen.evidenceId], deterministic: false,
      };
    }

    return {
      ...decision,
      action: decision.currentValue === null ? 'apply' : 'update',
      proposedValue: chosen.value,
      reasonCode: 'AMBIGUOUS_EVIDENCE',
      confidence: 'probable',
      evidenceIds: [chosen.evidenceId],
      sourcePriority: chosen.authorityScore,
      deterministic: false,
    };
  } catch (e) {
    // Indisponibilité du fournisseur : le pipeline reste fonctionnel (§11.4).
    console.error('[resolve_ambiguity] échec non bloquant :', (e as Error).message);
    return { ...decision, action: 'create_conflict',
      reasonCode: 'AMBIGUOUS_EVIDENCE', deterministic: true };
  }
}
