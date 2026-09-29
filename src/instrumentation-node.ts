/**
 * Amorçage applicatif, partie Node — appelé par `src/instrumentation.ts`.
 *
 * Isolé dans ce module pour que la compilation Edge de l'instrumentation
 * n'embarque pas les dépendances Node (web-push, pg, S3…) : Next.js retire
 * l'import dynamique ci-dessous du bundle Edge, pas un retour anticipé.
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
export async function registerNode(): Promise<void> {

  // 0. Secrets de signature des liens envoyés par e-mail (vérification
  //    d'adresse, réinitialisation du mot de passe). En production, sans
  //    secret, ces fonctions LÈVENT : le démarrage échoue volontairement.
  //    Un serveur qui démarrerait quand même signerait avec la valeur de
  //    repli publique — des liens fabricables par quiconque lit le dépôt, et
  //    le lien de vérification ouvre une session. Mieux vaut une mise en
  //    production bloquée qu'une faille silencieuse. Contrôle placé AVANT
  //    toute autre étape : rien ne doit tourner sans lui.
  const { emailVerificationSecret } = await import('@/services/auth/email-verification.service');
  const { resetSecret } = await import('@/services/auth/password-reset.service');
  emailVerificationSecret();
  resetSecret();

  // 1. Schéma. `ensureMigrations()` est idempotent, journalise chaque fichier
  //    appliqué et n'interrompt pas le démarrage en cas d'échec — les
  //    contrôles qui suivent tolèrent une table absente et le signalent.
  const { ensureMigrations } = await import('@/db');
  await ensureMigrations();

  //    CDC 15 DP-05 : colonnes de trace de la migration 0217. Absentes, les
  //    traces IA continuent sans TASK ni prompt maître — signalé ici, au
  //    démarrage, en erreur (le message est émis par le contrôle lui-même).
  const { traceMasterColumnsReady } = await import('@/services/ai/telemetry/trace-schema');
  await traceMasterColumnsReady();

  //    CDC 15 T1-04, §14.4 : colonnes des migrations 0218 (document_facts) et
  //    0219 (field_evidence). Absentes, les faits et preuves sont écrits sur
  //    les colonnes historiques (faits ciblés équipement/pièce non projetés) —
  //    signalé ici, en erreur, par le contrôle lui-même. Jamais bloquant.
  const { documentFactsCanonicalReady, fieldEvidenceCanonicalReady } = await import('@/services/ai/evidence/canonical-columns');
  await documentFactsCanonicalReady();
  await fieldEvidenceCanonicalReady();

  const { assertAiRegistryStartup, syncAiRegistry } = await import('@/services/ai/registry');
  const { assertPricingReady } = await import('@/services/ai/gateway/cost-catalog');

  // 2. Référentiel : un usage inconnu ou une opération mal rattachée doit
  //    empêcher le démarrage, pas produire des mesures fausses en silence.
  //    Contrôle purement statique — il ne lit que le code, jamais la base.
  assertAiRegistryStartup();

  //    Correspondance T1-T5 (CDC BO IA §1.3). Contrôle statique : une bijection
  //    rompue ferait appliquer une configuration au mauvais traitement.
  const { assertTreatmentMapping } = await import('@/services/ai/config/treatments');
  assertTreatmentMapping();

  //    Environnement (GEN-003). Il doit être connu HORS requête : c'est au
  //    démarrage qu'on détermine quelle version de configuration est effective.
  //
  //    ⚠️ SIGNALÉ BRUYAMMENT, MAIS N'INTERROMPT PAS LE DÉMARRAGE.
  //
  //    Une première version levait ici. C'était disproportionné : l'application
  //    entière — documents, comptes, facturation — serait tombée parce qu'une
  //    variable d'administration IA manquait. Un produit ne s'arrête pas pour
  //    une console.
  //
  //    La garde reste là où est le danger : `getAiEnvironment()` lève toujours
  //    chez ses appelants, et les opérations destructrices du snapshot la
  //    vérifient avant d'écrire quoi que ce soit. Ce qui est perdu sans cette
  //    variable, c'est le versioning de configuration — pas le produit.
  try {
    const { assertAiEnvironment } = await import('@/services/ai/config/environment');
    assertAiEnvironment();
  } catch (e) {
    console.error(
      `[startup] ⚠️ ${(e as Error).message} `
      + 'Le Back-Office IA ne pourra pas déterminer la version de configuration effective. '
      + 'Le reste de l\'application démarre normalement.',
    );
  }

  //    Modes de bascule : un drapeau ne doit pas porter un mode qu'il ne sait
  //    pas honorer. `AI_INTELLIGENT_ASSISTANT=shadow` ferait répondre deux
  //    moteurs aux mêmes questions (§10.4) — le démarrage échoue plutôt que de
  //    laisser croire à une mesure.
  const { assertFlagModesSupported } = await import('@/services/ai/flags/ai-feature-flags');
  assertFlagModesSupported();

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

  // 5 ter. Assistant — CDC §15.14 : contrôle du registre de modèles AU
  // DÉMARRAGE (et non plus au premier message) — alias résolus, modèles
  // autorisés, prix présents (cache tarifaire chargé à l'étape 3), sorties
  // structurées. Un échec rend l'assistant indisponible (503) et lève une
  // alerte dans le BO IA ; le reste de l'application démarre normalement.
  // §25.7 : abonnés aux événements métier (caches de l'assistant).
  const { runAssistantStartupCheck } = await import('@/services/verebona-assistant/core/model-startup-check');
  const { registerAssistantBusinessEventHandlers } = await import('@/services/verebona-assistant/events/handlers');
  registerAssistantBusinessEventHandlers();
  await runAssistantStartupCheck('startup').catch((e) =>
    console.error('[startup] contrôle du registre de l’assistant impossible :', (e as Error).message));

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

  //    Boucleur de la file IA (CDC BO IA GEN-004, NFR-003). Il ne porte aucun
  //    état : tout est en base, donc un redéploiement ne perd aucun travail.
  //    À terme il remplace `startAnalysisRecoveryScheduler`, qui repart de zéro
  //    à chaque démarrage — la coexistence est temporaire, le temps que T1 y
  //    enregistre son exécutant.
  //    L'exécutant T1 s'enregistre AVANT le boucleur : un premier tour lancé
  //    sans lui laisserait les travaux en file jusqu'au tour suivant.
  const { registerSourceAnalysisHandler } =
    await import('@/services/ai/source-analysis/queue/t1-handler');
  registerSourceAnalysisHandler();

  const { startQueueWorker } = await import('@/services/ai/queue/queue-worker');
  startQueueWorker();

  // 7. Sauvegarde quotidienne de la base.
  //
  // Le tableau de bord d'administration affichait l'âge de la « dernière
  // sauvegarde », mais aucune tâche n'en produisait. Le planificateur la
  // lance chaque nuit ; un bail en base évite les doublons entre instances.
  const { startDatabaseBackupScheduler } = await import(
    '@/services/backup/database-backup-scheduler'
  );
  startDatabaseBackupScheduler();

  // 8. Tâches quotidiennes de maintenance — même modèle que la sauvegarde
  //    (fenêtre horaire à Paris, bail en base, une exécution par jour) :
  //    cycle d'impayé (GAP-06), purge des exports RGPD expirés (GDP-022),
  //    contrôle d'ancienneté des sauvegardes. Le dépôt ne contient aucune
  //    configuration de planificateur d'hébergeur : sans ce démarrage, ces
  //    routes `/api/cron/*` n'auraient été appelées par personne.
  const { startDailyMaintenanceScheduler } = await import(
    '@/services/scheduling/daily-maintenance-scheduler'
  );
  startDailyMaintenanceScheduler();

  // 9. Dossiers prêts à l'emploi V12 (CDC Exports V12 §15.3) : worker de la
  //    file durable `export_generation` (rendu HTML/CSS + Chromium, une
  //    génération à la fois par instance). EXPORTS_WORKER_DISABLED=true le
  //    retire de cette instance.
  const { startExportWorker } = await import('@/services/exports/v12/generation/worker');
  startExportWorker();

  const { listRunningUseCases } = await import('@/services/ai/flags/use-case-flags');
  const running = listRunningUseCases();
  console.info(
    `[ai] domaine IA câblé — 5 usages déclarés, ${running.length} basculé(s)` +
    (running.length > 0 ? ` : ${running.join(', ')}` : ' (tous en mode legacy)'),
  );
}
