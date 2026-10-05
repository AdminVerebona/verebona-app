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

  // ── Revue ciblée ────────────────────────────────────────────────────────
  AMBIGUOUS_EVIDENCE: 'Preuve ambiguë, arbitrage ciblé nécessaire',
  PROBABLE_LINK: 'Liaison probable, arbitrage ciblé nécessaire',

  // ── Abstentions ─────────────────────────────────────────────────────────
  NO_EVIDENCE: 'Aucune preuve exploitable',
  UNNORMALIZABLE_VALUE: 'Valeur non normalisable, ignorée',
  ALREADY_DECIDED: 'Décision identique déjà prise sur cette version',
  // Historique : observation de la réconciliation négative (mode retiré au
  // lot 16b-3) — libellés conservés pour relire les décisions déjà en base.
  SHADOW_WOULD_RETRACT: 'Observation : cette valeur automatique serait retirée',
  SHADOW_WOULD_REPLACE_STALE: 'Observation : cette valeur automatique serait remplacée',
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

export function reasonLabel(code: string): string {
  return (REASON_CODES as Record<string, string>)[code] ?? code;
}
