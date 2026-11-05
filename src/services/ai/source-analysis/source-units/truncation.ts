/**
 * Lot 111M (ticket « budgets IA », P1 T1) — une erreur de passerelle est-elle
 * une SORTIE TRONQUÉE sur toute la chaîne (plafond de sortie atteint, jamais
 * acceptée comme réussite — décision PO 08) ? Pure.
 *
 * La passerelle porte la cause du dernier échec (`failureCause`) sur
 * `ALL_MODELS_FAILED` et sur la suspension (`AiSuspendedError`). Une sortie
 * tronquée n'est pas une panne : l'analyse peut être poursuivie par pages
 * (`continueByPages`), jamais déclarée complète.
 */
export function isTruncationFailure(e: unknown): boolean {
  const cause = (e as { failureCause?: unknown } | null)?.failureCause;
  return cause === 'OUTPUT_TRUNCATED';
}
