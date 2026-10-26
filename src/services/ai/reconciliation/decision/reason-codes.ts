/**
 * Codes de motif — catalogue fermé.
 *
 * Chaque décision porte un code stable : il est testable, affichable à
 * l'utilisateur dans « À arbitrer » et exploitable en audit (CDC §3.3,
 * « rendre explicites les décisions automatiques »).
 *
 * Un code non déclaré ici ne doit jamais apparaître dans une décision.
 */
export const REASON_CODES = {
  // ── Applications ────────────────────────────────────────────────────────
  EMPTY_FIELD_SINGLE_CERTAIN: 'Champ vide, preuve unique et explicite',
  EMPTY_FIELD_CONVERGING: 'Champ vide, plusieurs preuves concordantes',
  AUTO_VALUE_BETTER_AUTHORITY: 'Preuve plus autoritaire que la source actuelle',
  AUTO_VALUE_MORE_RECENT: 'Preuve plus récente, autorité équivalente',
  // CDC 15 T3-04 — réconciliation négative.
  STALE_AUTO_VALUE_REPLACED: 'Valeur automatique sans preuve active remplacée par la meilleure preuve restante',
  NO_REMAINING_EVIDENCE: 'Valeur automatique retirée : plus aucune preuve active',
  // Décision PO D-M (lot 20) — date tranchée par T4, preuve révisée.
  T4_DATE_REVISED: 'Date tranchée par l’agenda : valeur automatique corrigée par la preuve révisée',
  // Lot 76J (T3 complétude) — date d'achat vide, événement « achat » du bien
  // CONFIRMÉ par l'utilisateur (jamais un événement automatique non confirmé).
  EMPTY_FIELD_CONFIRMED_AGENDA: 'Champ vide : date d’un achat confirmé par l’utilisateur dans l’agenda',

  // ── Conservations ───────────────────────────────────────────────────────
  MANUAL_VALUE_CONFIRMED: 'Valeur saisie confirmée par un document',
  AUTO_VALUE_CONFIRMED: 'Valeur automatique confirmée par une nouvelle preuve',
  IDENTICAL_VALUE: 'Preuve identique à la valeur en place',
  WEAKER_EVIDENCE: 'Preuve moins autoritaire que la source actuelle',

  // ── Conflits ────────────────────────────────────────────────────────────
  MANUAL_VALUE_CONTRADICTED: 'Valeur saisie contredite par un document',
  EQUAL_AUTHORITY_DIVERGENCE: 'Deux sources de même autorité se contredisent',
  NO_AUTHORITY_RULE: "Aucune règle ne permet de départager les sources",
  CRITICAL_FIELD_INSUFFICIENT_PROOF: 'Champ critique : preuve insuffisante pour appliquer',
  MANUAL_LINK_CONTRADICTED: 'Liaison manuelle contredite par une détection',
  // Lot 76J : la fiche et un achat CONFIRMÉ par l'utilisateur dans l'agenda divergent.
  CONFIRMED_AGENDA_CONTRADICTION: 'La fiche contredit un achat confirmé dans l’agenda',

  // ── Revue ciblée ────────────────────────────────────────────────────────
  AMBIGUOUS_EVIDENCE: 'Preuve ambiguë, arbitrage ciblé nécessaire',
  PROBABLE_LINK: 'Liaison probable, arbitrage ciblé nécessaire',

  // ── Abstentions ─────────────────────────────────────────────────────────
  NO_EVIDENCE: 'Aucune preuve exploitable',
  UNNORMALIZABLE_VALUE: 'Valeur non normalisable, ignorée',
  ALREADY_DECIDED: 'Décision identique déjà prise sur cette version',
  // Lot 76J : texte libre (description, notes) jamais réécrit automatiquement.
  FREE_TEXT_PROTECTED: 'Texte libre en place : jamais réécrit automatiquement',
  // Lot 81A : proposition équivalente à la valeur en place après normalisation
  // métier — aucun arbitrage (ni carte, ni fermeture d'une carte existante).
  EQUIVALENT_VALUES: 'Valeurs équivalentes après normalisation : aucun arbitrage',
  // Historique : observation de la réconciliation négative (mode retiré au
  // lot 16b-3) — libellés conservés pour relire les décisions déjà en base.
  SHADOW_WOULD_RETRACT: 'Observation : cette valeur automatique serait retirée',
  SHADOW_WOULD_REPLACE_STALE: 'Observation : cette valeur automatique serait remplacée',
} as const;

export function reasonLabel(code: string): string {
  return (REASON_CODES as Record<string, string>)[code] ?? code;
}
