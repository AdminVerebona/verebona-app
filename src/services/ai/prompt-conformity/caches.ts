/**
 * Lot 99B — invalidation des caches concernés par une bascule de prompt.
 *
 * La bascule de configuration (`afterCommit`) invalide déjà la configuration,
 * la version tracée et les fichiers de prompt (clé partagée `ai-config` : les
 * autres instances relisent à l'appel suivant). Restent les caches de
 * CAPACITÉ « activée par marqueur » (60 s, propres à chaque instance) : ils
 * sont vidés ici dans l'instance qui bascule ; les autres suivent au plus
 * tard en une minute (comportement documenté du guide du PO).
 */
export async function invalidateCapabilityCaches(): Promise<string[]> {
  const vides: string[] = [];
  const essais: Array<[string, () => Promise<void>]> = [
    ['knowledge-query', async () => (await import('../reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests()],
    ['value-decisions', async () => (await import('../source-analysis/value-decisions/contract')).__resetValueDecisionsCapabilityCacheForTests()],
    ['billing-period', async () => (await import('../source-analysis/billing-period/contract')).__resetBillingPeriodCapabilityCacheForTests()],
    ['operation-identity', async () => (await import('@/services/business-operations/semantic/identity-decider')).__resetIdentityCapabilityCacheForTests()],
    ['agenda-representation', async () => (await import('@/services/business-operations/semantic/decider')).__resetRepresentationCapabilityCacheForTests()],
  ];
  for (const [nom, vider] of essais) {
    try { await vider(); vides.push(nom); } catch { /* module absent : rien à vider */ }
  }
  return vides;
}
