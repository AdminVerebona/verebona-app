/**
 * Moteur de décision — CDC §4.2.4 et §4.2.8.
 *
 * FONCTION PURE, SANS EFFET DE BORD ET SANS ACCÈS BASE.
 * C'est délibéré : les onze situations de la matrice §4.2.4 deviennent une table
 * de vérité testable exhaustivement, plutôt qu'une cascade de `if` répartie dans
 * un service de 650 lignes — la forme qu'avait `enrich-and-coherence.service.ts`
 * et qui rendait tout raisonnement sur son comportement impossible.
 *
 * ORDRE IMPOSÉ (§4.2.8), déterministe d'abord :
 *   1. normalisation des valeurs      (faite en amont par le collecteur)
 *   2. règles de type de document     (matrice d'autorité)
 *   3. priorité des sources           (score d'autorité)
 *   4. comparaison de dates
 *   5. correspondances exactes
 *   6. graphe de dépendances          (en amont, propagation)
 *   7. LLM uniquement si ambiguïté    → action `request_ai_review`
 *
 * Cette fonction ne déclenche AUCUN appel modèle : elle se contente de signaler
 * qu'un arbitrage ciblé est nécessaire.
 */
import type {
  DecisionInput, ReconciliationDecision, EvidenceCandidate, CurrentValue,
} from '../types';
import { AUTHORITY_EQUIVALENCE_MARGIN, isAtLeast, weakestConfidence, confidenceRank } from './confidence';
import { checkCriticalGate } from './critical-fields';
import { canRequestAiReview } from './ai-exclusion';

export function decide(input: DecisionInput): ReconciliationDecision {
  const base = {
    fieldKey: input.fieldKey,
    currentValue: input.current?.value ?? null,
    deterministic: true,
  };

  // ── Aucune preuve exploitable ──────────────────────────────────────────
  if (input.candidates.length === 0) {
    return { ...base, proposedValue: null, action: 'ignore',
      reasonCode: 'NO_EVIDENCE', confidence: 'conflictual', evidenceIds: [] };
  }

  const usable = input.candidates.filter((c) => c.normalized !== null && c.normalized !== '');
  if (usable.length === 0) {
    return { ...base, proposedValue: null, action: 'ignore',
      reasonCode: 'UNNORMALIZABLE_VALUE', confidence: 'conflictual',
      evidenceIds: input.candidates.map((c) => c.evidenceId) };
  }

  // ── Étapes 2 à 4 : autorité, puis date ─────────────────────────────────
  const ranked = [...usable].sort(compareByAuthorityThenDate);
  const groups = groupByNormalizedValue(ranked);
  const best = ranked[0];
  const bestGroup = groups.get(best.normalized!)!;

  // ── Divergence entre sources ───────────────────────────────────────────
  if (groups.size > 1) {
    const rivals = [...groups.values()]
      .filter((g) => g[0].normalized !== best.normalized)
      .map((g) => g[0]);
    const closestRival = rivals[0];
    const gap = best.authorityScore - closestRival.authorityScore;

    // Aucune règle ne permet de départager : conflit, sans écrasement (§4.2.4).
    if (gap <= AUTHORITY_EQUIVALENCE_MARGIN) {
      return {
        ...base,
        proposedValue: best.value,
        action: 'create_conflict',
        reasonCode: gap === 0 ? 'NO_AUTHORITY_RULE' : 'EQUAL_AUTHORITY_DIVERGENCE',
        confidence: 'conflictual',
        evidenceIds: [...bestGroup, closestRival].map((c) => c.evidenceId),
        sourcePriority: best.authorityScore,
      };
    }
    // Écart net : la source prioritaire l'emporte et l'historique est conservé.
  }

  // ── Champ vide ─────────────────────────────────────────────────────────
  if (isEmpty(input.current)) {
    return decideOnEmptyField(base, input, best, bestGroup);
  }

  // ── Valeur confirmée ───────────────────────────────────────────────────
  if (input.current!.normalized === best.normalized) {
    return {
      ...base,
      proposedValue: input.current!.value,
      action: 'keep',
      reasonCode: input.current!.origin === 'USER' || input.current!.origin === 'ADMIN'
        ? 'MANUAL_VALUE_CONFIRMED'
        : 'AUTO_VALUE_CONFIRMED',
      confidence: best.confidence,
      evidenceIds: bestGroup.map((c) => c.evidenceId),
      sourcePriority: best.authorityScore,
    };
  }

  // ── Valeur contredite ──────────────────────────────────────────────────
  return decideOnContradiction(base, input, best, bestGroup);
}

/** Champ vide : appliquer si la preuve est nette, sinon proposer. */
function decideOnEmptyField(
  base: Pick<ReconciliationDecision, 'fieldKey' | 'currentValue' | 'deterministic'>,
  input: DecisionInput,
  best: EvidenceCandidate,
  bestGroup: EvidenceCandidate[],
): ReconciliationDecision {
  const evidenceIds = bestGroup.map((c) => c.evidenceId);

  // Champ critique : les quatre conditions cumulatives du §4.2.6.
  if (input.isCritical) {
    const gate = checkCriticalGate(input.fieldKey, best);
    if (!gate.allowed) {
      return {
        ...base, proposedValue: best.value, action: 'create_conflict',
        reasonCode: 'CRITICAL_FIELD_INSUFFICIENT_PROOF',
        confidence: best.confidence, evidenceIds,
        sourcePriority: best.authorityScore,
      };
    }
  }

  if (isAtLeast(best.confidence, 'certain')) {
    return {
      ...base, proposedValue: best.value, action: 'apply',
      reasonCode: bestGroup.length > 1 ? 'EMPTY_FIELD_CONVERGING' : 'EMPTY_FIELD_SINGLE_CERTAIN',
      confidence: weakestConfidence(bestGroup.map((c) => c.confidence)),
      evidenceIds, sourcePriority: best.authorityScore,
    };
  }

  // Preuve probable ou ambiguë : proposition ou revue ciblée (§4.2.4).
  // Exception : un champ exclu du périmètre modèle (coordonnées bancaires) ne
  // peut jamais faire l'objet d'un arbitrage IA — il part directement en
  // arbitrage utilisateur (CDC Assistant §16.2).
  return {
    ...base, proposedValue: best.value,
    action: canRequestAiReview(input.fieldKey) ? 'request_ai_review' : 'create_conflict',
    reasonCode: 'AMBIGUOUS_EVIDENCE', confidence: best.confidence,
    evidenceIds, sourcePriority: best.authorityScore,
  };
}

/** Valeur en place contredite par une preuve. */
function decideOnContradiction(
  base: Pick<ReconciliationDecision, 'fieldKey' | 'currentValue' | 'deterministic'>,
  input: DecisionInput,
  best: EvidenceCandidate,
  bestGroup: EvidenceCandidate[],
): ReconciliationDecision {
  const current = input.current!;
  const evidenceIds = bestGroup.map((c) => c.evidenceId);

  // ⚠️ RÈGLE ABSOLUE (§4.2.5, critère d'acceptation n°11) : une valeur saisie
  // par un humain n'est JAMAIS écrasée silencieusement. Aucune autorité
  // documentaire, aussi forte soit-elle, ne passe outre.
  if (current.origin === 'USER' || current.origin === 'ADMIN') {
    return {
      ...base, proposedValue: best.value, action: 'create_conflict',
      reasonCode: 'MANUAL_VALUE_CONTRADICTED', confidence: best.confidence,
      evidenceIds, sourcePriority: best.authorityScore,
    };
  }

  // Valeur automatique : remplaçable par une meilleure preuve (§4.2.5).
  if (input.isCritical) {
    const gate = checkCriticalGate(input.fieldKey, best);
    if (!gate.allowed) {
      return {
        ...base, proposedValue: best.value, action: 'create_conflict',
        reasonCode: 'CRITICAL_FIELD_INSUFFICIENT_PROOF',
        confidence: best.confidence, evidenceIds,
        sourcePriority: best.authorityScore,
      };
    }
  }

  const currentAuthority = current.authorityScore ?? 0;
  const gap = best.authorityScore - currentAuthority;

  // Preuve nettement plus autoritaire : mise à jour automatique.
  if (gap > AUTHORITY_EQUIVALENCE_MARGIN) {
    return {
      ...base, proposedValue: best.value, action: 'update',
      reasonCode: 'AUTO_VALUE_BETTER_AUTHORITY', confidence: best.confidence,
      evidenceIds, sourcePriority: best.authorityScore,
    };
  }

  // Preuve nettement moins autoritaire : on conserve.
  if (gap < -AUTHORITY_EQUIVALENCE_MARGIN) {
    return {
      ...base, proposedValue: current.value, action: 'keep',
      reasonCode: 'WEAKER_EVIDENCE', confidence: best.confidence,
      evidenceIds, sourcePriority: currentAuthority,
    };
  }

  // Autorité équivalente : la date tranche (§4.2.8, étape 4).
  if (isMoreRecent(best.documentDate, current.sourceDate ?? current.updatedAt)) {
    return {
      ...base, proposedValue: best.value, action: 'update',
      reasonCode: 'AUTO_VALUE_MORE_RECENT', confidence: best.confidence,
      evidenceIds, sourcePriority: best.authorityScore,
    };
  }

  // Même autorité, pas plus récent : arbitrage (§4.2.4).
  return {
    ...base, proposedValue: best.value, action: 'create_conflict',
    reasonCode: 'EQUAL_AUTHORITY_DIVERGENCE', confidence: 'conflictual',
    evidenceIds, sourcePriority: best.authorityScore,
  };
}

// ── Utilitaires ────────────────────────────────────────────────────────────

function compareByAuthorityThenDate(a: EvidenceCandidate, b: EvidenceCandidate): number {
  if (b.authorityScore !== a.authorityScore) return b.authorityScore - a.authorityScore;
  const da = a.documentDate?.getTime() ?? 0;
  const db = b.documentDate?.getTime() ?? 0;
  if (db !== da) return db - da;
  // Départage stable : la preuve la plus confiante, puis la plus récente en base.
  const confidenceGap = confidenceRank(b.confidence) - confidenceRank(a.confidence);
  if (confidenceGap !== 0) return confidenceGap;
  return b.evidenceId - a.evidenceId;
}

function groupByNormalizedValue(
  candidates: EvidenceCandidate[],
): Map<string, EvidenceCandidate[]> {
  const groups = new Map<string, EvidenceCandidate[]>();
  for (const c of candidates) {
    const key = c.normalized!;
    const existing = groups.get(key);
    if (existing) existing.push(c);
    else groups.set(key, [c]);
  }
  return groups;
}

function isEmpty(current: CurrentValue | null): boolean {
  return current === null || current.normalized === null || current.normalized === '';
}

function isMoreRecent(candidate: Date | null, reference: Date | null | undefined): boolean {
  if (!candidate) return false;
  if (!reference) return true;
  return candidate.getTime() > reference.getTime();
}
