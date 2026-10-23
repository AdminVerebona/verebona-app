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
  DecisionInput, ReconciliationDecision, EvidenceCandidate, CurrentValue, DecisionAlternative,
} from '../types';
import { areBusinessEquivalent, realAlternatives } from './equivalence';
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
  // Lot 81A : groupes de valeurs ÉQUIVALENTES au sens métier (registre
  // canonique + normalisation historique) — « 06/05/2021 » et « 2021-05-06 »
  // sont une seule valeur, quelle que soit la clé de preuve (alias compris).
  const groups = groupByEquivalence(input.fieldKey, ranked);
  const best = ranked[0];
  const bestGroup = groups[0];
  const filled = !isEmpty(input.current);
  /** La preuve porte-t-elle la valeur EN PLACE (après normalisation métier) ? */
  const matchesCurrent = (c: EvidenceCandidate): boolean => filled && (
    c.normalized === input.current!.normalized || areBusinessEquivalent(input.fieldKey, c.value, input.current!.value));

  // ── Divergence entre sources ───────────────────────────────────────────
  if (groups.length > 1) {
    const closestRival = groups[1][0];
    const gap = best.authorityScore - closestRival.authorityScore;

    // Aucune règle ne permet de départager : conflit, sans écrasement (§4.2.4).
    if (gap <= AUTHORITY_EQUIVALENCE_MARGIN) {
      // ══════════════════════════════════════════════════════════════════
      // LOT 81A — LA CONTRADICTION RÉELLE, PAS LA MEILLEURE PREUVE
      //
      // Avant : la proposition était TOUJOURS `best.value`, même quand elle
      // égalait la valeur en place (acte A = fiche = 06/05/2021, acte B =
      // 17/05/2021 → « 06/05/2021 ou 06/05/2021 ? »). Désormais, parmi les
      // valeurs que l'autorité ne départage pas, seules celles qui DIFFÈRENT
      // de la valeur en place sont proposées — toutes, sans en masquer une.
      // Les preuves des deux côtés restent citées (signature inchangée pour
      // deux valeurs : mémoire des arbitrages déjà tranchés préservée).
      // ══════════════════════════════════════════════════════════════════
      const contenders = groups.filter((g) => best.authorityScore - g[0].authorityScore <= AUTHORITY_EQUIVALENCE_MARGIN);
      const divergent = contenders.filter((g) => !matchesCurrent(g[0]));
      if (divergent.length > 0) {
        const first = divergent[0][0];
        const evidenceIds = [...new Set([
          ...bestGroup.map((c) => c.evidenceId), closestRival.evidenceId, ...contenders.slice(2).map((g) => g[0].evidenceId),
        ])];
        return {
          ...base,
          proposedValue: first.value,
          action: 'create_conflict',
          reasonCode: gap === 0 ? 'NO_AUTHORITY_RULE' : 'EQUAL_AUTHORITY_DIVERGENCE',
          confidence: 'conflictual',
          evidenceIds,
          sourcePriority: first.authorityScore,
          alternatives: divergent.map((g) => ({
            value: g[0].value, evidenceIds: g.map((c) => c.evidenceId), confidence: g[0].confidence, sourcePriority: g[0].authorityScore,
          })),
        };
      }
      // Toutes les valeurs non départagées égalent la valeur en place : rien à arbitrer.
    }
    // Écart net : la source prioritaire l'emporte et l'historique est conservé.
  }

  // ── Champ vide ─────────────────────────────────────────────────────────
  if (!filled) {
    return decideOnEmptyField(base, input, best, bestGroup);
  }

  // ── Valeur confirmée ───────────────────────────────────────────────────
  if (matchesCurrent(best)) {
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

/**
 * Groupes de preuves de valeurs équivalentes, dans l'ordre d'autorité (le
 * premier groupe porte la meilleure preuve). Lot 81A : l'équivalence est
 * MÉTIER (`areBusinessEquivalent`) — même valeur normalisée, ou même valeur
 * pour le registre canonique.
 */
function groupByEquivalence(fieldKey: string, candidates: EvidenceCandidate[]): EvidenceCandidate[][] {
  const groups: EvidenceCandidate[][] = [];
  for (const c of candidates) {
    const g = groups.find((x) => x[0].normalized === c.normalized || areBusinessEquivalent(fieldKey, x[0].value, c.value));
    if (g) g.push(c);
    else groups.push([c]);
  }
  return groups;
}

/**
 * Lot 81A — garde finale d'un conflit (pure) : les valeurs proposées
 * équivalentes à la valeur en place (ou en double) sont écartées. Sans
 * aucune véritable alternative, le conflit n'en est pas un : abstention
 * `EQUIVALENT_VALUES` — ni carte, ni fermeture d'une carte existante (une
 * contradiction réelle n'est jamais déclarée résolue parce qu'une
 * proposition était mal choisie). Filet de sécurité pour les décisions qui
 * ne viennent pas de `decide` (revue ciblée, confrontation agenda).
 */
export function withoutEquivalentProposals(d: ReconciliationDecision): ReconciliationDecision {
  if (d.action !== 'create_conflict') return d;
  const valeurs: DecisionAlternative[] = d.alternatives?.length
    ? d.alternatives
    : [{ value: d.proposedValue, evidenceIds: d.evidenceIds, confidence: d.confidence, sourcePriority: d.sourcePriority }];
  const reelles = realAlternatives(d.fieldKey, d.currentValue, valeurs, (a) => a.value);
  if (reelles.length === 0) {
    return { ...d, action: 'ignore', proposedValue: null, reasonCode: 'EQUIVALENT_VALUES', alternatives: undefined };
  }
  if (reelles.length === valeurs.length) return d;
  return { ...d, proposedValue: reelles[0].value, ...(d.alternatives ? { alternatives: reelles } : {}) };
}

function isEmpty(current: CurrentValue | null): boolean {
  return current === null || current.normalized === null || current.normalized === '';
}

function isMoreRecent(candidate: Date | null, reference: Date | null | undefined): boolean {
  if (!candidate) return false;
  if (!reference) return true;
  return candidate.getTime() > reference.getTime();
}
