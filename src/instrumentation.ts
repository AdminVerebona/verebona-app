/**
 * Amorçage applicatif — convention Next.js 15.
 *
 * Point unique où le domaine IA est câblé. Trois responsabilités :
 *   1. contrôles de cohérence qui doivent faire échouer le démarrage ;
 *   2. synchronisation du référentiel vers la base ;
 *   3. abonnement des moteurs aval aux événements d'analyse.
 *
 * L'ordre compte : les contrôles avant le câblage, pour qu'une configuration
 * incohérente n'ait jamais l'occasion de traiter un document.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertAiRegistryStartup, syncAiRegistry } = await import('@/services/ai/registry');
  const { assertPricingReady } = await import('@/services/ai/gateway/cost-catalog');

  // 1. Référentiel : un usage inconnu ou une opération mal rattachée doit
  //    empêcher le démarrage, pas produire des mesures fausses en silence.
  assertAiRegistryStartup();

  // 2. Tarifs : en production, un modèle sans tarif bloque le démarrage.
  //    Corrige le défaut n°10 — mieux vaut ne pas démarrer que facturer faux.
  await assertPricingReady();

  // 3. Projection du référentiel en base, pour l'administration et les
  //    jointures SQL avec les tables de suivi.
  await syncAiRegistry();

  // 4. Câblage des usages. L'analyse (usage 1) émet des événements ; la
  //    réconciliation (usage 2) et l'agenda (usage 4) s'y abonnent. Aucun
  //    import direct entre eux : c'est ce qui rend le mode observation possible.
  const { registerReconciliationHandlers } = await import('@/services/ai/reconciliation');
  const { registerAgendaHandlers } = await import('@/services/ai/agenda');
  const { initAssistant } = await import('@/services/ai/assistant');

  registerReconciliationHandlers();
  initAssistant();

  // L'agenda reçoit ses accès base par injection : le module reste testable
  // sans démarrer l'application.
  const { loadExistingAgendaItems, persistAgendaDecisions } =
    await import('@/services/agenda/agenda-persistence');
  registerAgendaHandlers(loadExistingAgendaItems, persistAgendaDecisions);

  console.info('[ai] domaine IA câblé — 5 usages actifs');
}
