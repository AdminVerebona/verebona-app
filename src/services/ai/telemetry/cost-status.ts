/**
 * Statut tarifaire d'un appel IA — lot 109L (ticket P1 « Tarifs Gemini non
 * reconnus », point C, migration 1150).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REMPLACE L'HEURISTIQUE `cost_micros = 0 AND input_tokens > 0`
 *
 * L'ancienne règle comptait « sans tarif » des coûts CONNUS arrondis à zéro
 * (appel de quelques jetons) et ignorait les appels n'ayant que des jetons de
 * sortie. Le statut est désormais ÉCRIT à la création de la trace :
 *
 *   applied             tarif appliqué, coût > 0 (au micro-dollar) ;
 *   zero_or_rounded     tarif connu et coût nul ou arrondi à 0 (le coût exact
 *                       est dans `cost_exact_micros`), ou aucune consommation
 *                       (refus avant appel, 0 jeton en échec) : coût VRAIMENT nul ;
 *   missing             jetons consommés, aucun tarif applicable : coût NULL,
 *                       non calculable, jamais estimé ;
 *   insufficient_usage  réponse reçue sans compteur de jetons : consommation
 *                       inconnue, coût non calculable ;
 *   legacy_undetermined trace ancienne dont l'origine du coût nul n'est pas
 *                       prouvable (ni référence tarifaire, ni coût NULL).
 *
 * Les traces antérieures (colonne NULL) ne sont PAS réécrites : leur statut est
 * DÉDUIT à la lecture par `PRICING_STATUS_SQL`, à partir de ce qui est prouvé
 * (coût NULL = calcul impossible ; `metadata.pricing` présent = tarif en cache
 * au moment de l'appel ; clé absente = historique sans preuve).
 * ══════════════════════════════════════════════════════════════════════════
 */

export const PRICING_STATUSES = ['applied', 'zero_or_rounded', 'missing', 'insufficient_usage', 'legacy_undetermined'] as const;
export type PricingStatus = (typeof PRICING_STATUSES)[number];

/** Statuts dont le coût est INCONNU (le total qui les contient est partiel). */
export const UNKNOWN_COST_STATUSES: readonly PricingStatus[] = ['missing', 'insufficient_usage', 'legacy_undetermined'];

export const PRICING_STATUS_LABELS: Readonly<Record<PricingStatus, string>> = {
  applied: 'Tarif appliqué',
  zero_or_rounded: 'Coût nul ou arrondi à zéro (tarif connu)',
  missing: 'Tarif absent : coût non calculable',
  insufficient_usage: 'Consommation non mesurée',
  legacy_undetermined: 'Trace ancienne : origine du coût non prouvable',
};

/**
 * Statut d'un NOUVEL appel (pur). `priced` : un tarif était applicable au
 * moment de l'appel (référence tarifaire figée non nulle).
 */
export function pricingStatusOf(t: {
  status: 'success' | 'error';
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  costMicros: number | null;
  priced: boolean;
}): PricingStatus {
  const tokens = Math.max(0, t.inputTokens ?? 0) + Math.max(0, t.outputTokens ?? 0);
  if (tokens === 0) {
    // Réponse reçue sans compteur : on ne sait pas ce qui a été consommé.
    if (t.status === 'success') return 'insufficient_usage';
    // Refus avant appel, échec sans réponse : rien de consommé, coût vraiment nul.
    return 'zero_or_rounded';
  }
  if (t.costMicros === null) return 'missing';
  if (t.costMicros > 0) return 'applied';
  // Coût 0 avec jetons : arrondi d'un tarif CONNU… ou tarif absent (ancien code).
  return t.priced ? 'zero_or_rounded' : 'missing';
}

/**
 * Statut EFFECTIF d'une ligne `ai_usage_event` (alias `u`) : écrit (lot 109L)
 * ou déduit pour les traces antérieures. Fragment SQL partagé (rapports,
 * diagnostic, régularisation) — une seule définition.
 */
export function pricingStatusSql(u = 'u'): string {
  return `(CASE
    WHEN ${u}.pricing_status IS NOT NULL THEN ${u}.pricing_status
    WHEN COALESCE(${u}.input_tokens, 0) <= 0 AND COALESCE(${u}.output_tokens, 0) <= 0
      THEN CASE WHEN ${u}.status = 'success' THEN 'insufficient_usage' ELSE 'zero_or_rounded' END
    WHEN ${u}.cost_micros IS NULL THEN 'missing'
    WHEN ${u}.cost_micros > 0 THEN 'applied'
    WHEN ${u}.metadata ? 'pricing' AND jsonb_typeof(${u}.metadata->'pricing') = 'object' THEN 'zero_or_rounded'
    WHEN ${u}.metadata ? 'pricing' THEN 'missing'
    ELSE 'legacy_undetermined'
  END)`;
}

/** Coût INCONNU (statut effectif), corrections non comprises. */
export function unknownCostSql(u = 'u'): string {
  return `(${pricingStatusSql(u)} IN ('missing', 'insufficient_usage', 'legacy_undetermined'))`;
}

/**
 * Jointure de la correction ACTIVE d'un appel (régularisation, lot 109L).
 * Coût effectif = correction active sinon coût initial — jamais les deux.
 */
export function activeCorrectionJoin(u = 'u', c = 'c'): string {
  return `LEFT JOIN ai_cost_corrections ${c} ON ${c}.target_kind = 'event' AND ${c}.target_id = ${u}.id AND ${c}.reverted_at IS NULL`;
}

/** Complétude d'un agrégat (pur) : complet / partiel / inconnu. */
export type CostCompleteness = 'complete' | 'partial' | 'unknown';
export function completenessOf(calls: number, unknownCalls: number): CostCompleteness {
  if (unknownCalls <= 0) return 'complete';
  return unknownCalls >= calls ? 'unknown' : 'partial';
}

export const COMPLETENESS_LABELS: Readonly<Record<CostCompleteness, string>> = {
  complete: 'Complet',
  partial: 'Partiel : des appels ne sont pas chiffrés',
  unknown: 'Inconnu : aucun appel chiffré',
};
