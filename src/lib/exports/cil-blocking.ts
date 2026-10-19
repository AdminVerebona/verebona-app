/**
 * CIL — règle de blocage (CIL-RULE-002) et message construit sur l'ÉTAT
 * RÉEL (lot 69, ticket « diagnostics codés en dur », §3.1). Pur, partagé
 * serveur et client.
 *
 * `CIL_BLOCKING_BLOCK_IDS` DÉFINIT la règle : les blocs SUSCEPTIBLES de
 * bloquer la génération. Il ne décrit jamais l'état d'un bien : le message
 * utilisateur est construit à partir des `blockingBlocks` réellement
 * retournés par l'évaluation (`evaluateCilReadiness`) — si seul B3 manque,
 * seul « Plans et coupes » est cité.
 */

/** CIL-RULE-002 : blocs pouvant bloquer la génération (règle, pas état). */
export const CIL_BLOCKING_BLOCK_IDS = ['B1', 'B3', 'B8'] as const;

export function isCilBlockingRuleBlock(id: string): boolean {
  return (CIL_BLOCKING_BLOCK_IDS as readonly string[]).includes(id);
}

/** Bloc réellement bloquant, tel que transmis à l'interface. */
export interface CilBlockingBlockRef {
  id: string;
  label: string;
}

/** « A », « A et B », « A, B et C ». */
export function joinFr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

/**
 * Message de blocage, ou `null` si aucun bloc ne bloque.
 *   B3 seul   → « Plans et coupes à compléter avant de générer le CIL. »
 *   B3 + B8   → « Plans et coupes et Documents de performance énergétique sont à compléter avant de générer le CIL. »
 */
export function cilBlockingMessage(blocks: readonly CilBlockingBlockRef[] | null | undefined): string | null {
  const labels = (blocks ?? []).map((b) => b.label.trim()).filter(Boolean);
  if (labels.length === 0) return null;
  return labels.length === 1
    ? `${labels[0]} à compléter avant de générer le CIL.`
    : `${joinFr(labels)} sont à compléter avant de générer le CIL.`;
}

/**
 * Refus de génération (API) : même liste réelle, phrase autonome. Sans
 * détail disponible (ancien appel), une phrase générique — jamais une liste
 * de blocs supposés manquants.
 */
export function cilActionRequiredMessage(blocks: readonly CilBlockingBlockRef[] | null | undefined): string {
  const labels = (blocks ?? []).map((b) => b.label.trim()).filter(Boolean);
  if (labels.length === 0) return CIL_ACTION_REQUIRED_GENERIC_MESSAGE;
  return `Le CIL ne peut pas encore être généré : ${labels.length === 1 ? `le bloc « ${labels[0]} » est à compléter` : `les blocs ${joinFr(labels.map((l) => `« ${l} »`))} sont à compléter`}.`;
}

export const CIL_ACTION_REQUIRED_GENERIC_MESSAGE =
  'Le CIL ne peut pas encore être généré : complétez d’abord les blocs bloquants signalés dans la préparation.';
