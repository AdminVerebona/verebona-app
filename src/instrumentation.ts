/**
 * Amorçage applicatif — convention Next.js 15.
 *
 * Point unique où le domaine IA est câblé. Quatre responsabilités :
 *   1. mise à niveau du schéma de base ;
 *   2. contrôles de cohérence qui doivent faire échouer le démarrage ;
 *   3. synchronisation du référentiel vers la base ;
 *   4. abonnement des moteurs aval aux événements d'analyse.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ L'ORDRE EST LA CORRECTION PRINCIPALE DE CE FICHIER
 *
 * La version précédente n'appelait pas `ensureMigrations()`. Les contrôles de
 * démarrage lisaient donc `ai_model_pricing`, et la synchronisation écrivait
 * dans `ai_use_cases` et `ai_operations` — quatre tables créées par les
 * migrations 0101 et 0111, qui n'avaient jamais été appliquées. Au premier
 * déploiement : exception au démarrage, application indisponible.
 *
 * Les migrations viennent donc en premier, et rien qui touche à la base ne
 * s'exécute avant elles.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // 1. Schéma. `ensureMigrations()` est idempotent, journalise chaque fichier
  //    appliqué et n'interrompt pas le démarrage en cas d'échec — les
  //    contrôles qui suivent tolèrent une table absente et le signalent.
  const { ensureMigrations } = await import('@/db');
  await ensureMigrations();

  const { assertAiRegistryStartup, syncAiRegistry } = await import('@/services/ai/registry');
  const { assertPricingReady } = await import('@/services/ai/gateway/cost-catalog');

  // 2. Référentiel : un usage inconnu ou une opération mal rattachée doit
  //    empêcher le démarrage, pas produire des mesures fausses en silence.
  //    Contrôle purement statique — il ne lit que le code, jamais la base.
  assertAiRegistryStartup();

  // 3. Tarifs : en production, un modèle sans tarif bloque le démarrage —
  //    mais uniquement si l'usage qui l'emploie est réellement basculé
  //    (cf. `cost-catalog.ts`). Corrige le défaut n°10 sans rendre le socle
  //    indéployable tant que les cinq drapeaux valent `legacy`.
  await assertPricingReady();

  // 4. Projection du référentiel en base, pour l'administration et les
  //    jointures SQL avec les tables de suivi.
  await syncAiRegistry();

  // 5. Câblage des usages. L'analyse (usage 1) émet des événements ; la
  //    réconciliation (usage 2) et l'agenda (usage 4) s'y abonnent. Aucun
  //    import direct entre eux : c'est ce qui rend le mode observation possible.
  const { registerReconciliationHandlers } = await import('@/services/ai/reconciliation');
  const { registerAgendaHandlers } = await import('@/services/ai/agenda');
  const { initAssistant } = await import('@/services/ai/assistant');

  registerReconciliationHandlers();
  initAssistant();

  // 5 bis. Adaptateurs de récupération de l'assistant.
  //
  // Sans cet appel, `getEnabledAdapters()` rend un tableau vide et
  // `retrieve()` retombe sur son repli minimal : une recherche par NOM DE
  // BIEN, et rien d'autre. L'assistant ne pouvait trouver ni document, ni
  // échéance, ni équipement.
  //
  // Le code des adaptateurs existait ; il manquait cet enregistrement.
  const { registerAllRetrievalAdapters } = await import(
    '@/services/verebona-assistant/registries'
  );
  registerAllRetrievalAdapters();

  // L'agenda reçoit ses accès base par injection : le module reste testable
  // sans démarrer l'application.
  const { loadExistingAgendaItems, persistAgendaDecisions } =
    await import('@/services/agenda/agenda-persistence');
  registerAgendaHandlers(loadExistingAgendaItems, persistAgendaDecisions);

  // 6. Reprise automatique des analyses.
  //
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ CE PLANIFICATEUR N'ÉTAIT DÉMARRÉ NULLE PART
  //
  // `analysis-recovery.service` sait reprendre les documents jamais analysés,
  // les échecs récupérables et les analyses bloquées depuis plus de dix
  // minutes. `startAnalysisRecoveryScheduler()` existait pour le déclencher
  // toutes les cinq minutes — sans aucun appelant dans le dépôt.
  //
  // Un document déposé pendant que le quota était épuisé restait donc en
  // attente indéfiniment, sauf appel manuel de `/api/cron/retry-analysis`.
  //
  // Le tour est protégé par un bail en base : plusieurs instances peuvent
  // démarrer ce planificateur sans se marcher dessus.
  // ══════════════════════════════════════════════════════════════════════════
  const { startAnalysisRecoveryScheduler } = await import(
    '@/services/document-ai/analysis-recovery-scheduler'
  );
  startAnalysisRecoveryScheduler();

  const { listRunningUseCases } = await import('@/services/ai/flags/use-case-flags');
  const running = listRunningUseCases();
  console.info(
    `[ai] domaine IA câblé — 5 usages déclarés, ${running.length} basculé(s)` +
    (running.length > 0 ? ` : ${running.join(', ')}` : ' (tous en mode legacy)'),
  );
}
