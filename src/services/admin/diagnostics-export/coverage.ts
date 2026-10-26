/**
 * Lot 88A — REGISTRE DE COUVERTURE du diagnostic global (ticket P1
 * « Rendre le diagnostic global exhaustif et auto-suffisant »). PUR (aucun
 * import serveur) : partagé par le moteur (`account.ts`), le guide
 * d'analyse, le manifeste et les tests de non-régression.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE DE NON-RÉGRESSION (contrat d'observabilité)
 *
 * Toute table de la base est soit COUVERTE (section du diagnostic, filtre de
 * compte), soit EXCLUE avec une catégorie et un motif. Le test unitaire
 * `l88a-diagnostic-global.test.ts` compare les tables du schéma Drizzle à ce
 * registre et ÉCHOUE si une table n'y est pas déclarée ; l'e2e L88A fait de
 * même avec les tables réellement présentes en base (migrations SQL
 * comprises). Idem pour les traitements IA (`AI_OPERATIONS`) : chacun doit
 * être déclaré dans `DIAG_AI_OPERATION_COVERAGE` (où retrouver son entrée,
 * sa sortie et ses décisions). Une évolution qui ajoute un objet, une
 * relation, un traitement ou une décision met à jour ce fichier dans le même
 * développement (docs/exploitation/diagnostic-global.md).
 *
 * Une table présente en base mais absente du registre est EXPORTÉE quand
 * même si elle porte `account_id` (section « non-classees », avertissement,
 * section PARTIAL) : jamais d'omission silencieuse.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type DiagSectionCode =
  | 'etat-metier' | 'documents' | 'relations' | 'extractions-ia' | 'preuves' | 'candidats' | 'conflits-arbitrages'
  | 'ecritures' | 'corrections-utilisateur' | 'rapprochements-agenda-controles' | 'historique' | 'technique'
  | 'referentiels' | 'api-ui' | 'tracabilite' | 'controle' | 'non-classees';

export type DiagSectionStatus = 'COMPLETE' | 'PARTIAL' | 'NOT_APPLICABLE' | 'ERROR';

export const DIAG_SECTIONS: Readonly<Record<DiagSectionCode, { label: string; description: string }>> = {
  'etat-metier': { label: 'État métier complet', description: 'Compte, membres, abonnements, biens, Pièces, équipements, contrats, financements, sinistres, composantes financières, agenda et échéances, fournisseurs : chaque ligne avec toutes ses colonnes (statut, propriétés, dates, origine, suppression logique, verrouillage).' },
  documents: { label: 'Documents', description: 'Documents (métadonnées, classement, statut d’analyse, titres), versions, lots de dépôt, nommage, reprises. Le fichier original n’est jamais exporté.' },
  relations: { label: 'Relations', description: 'Rattachements document ↔ bien / équipement / Pièce (actuels et retirés), sources et liens des rapprochements, liens d’agenda, origine, méthode, confiance, date de retrait.' },
  'extractions-ia': { label: 'Extractions IA (T1, T2, T3, T4, T6)', description: 'Extractions T1 et faits persistés (un par ligne), unités sources (entrée utile), tableaux, couverture, analyses, rapports d’exécution, interprétations T3 de la connaissance, évaluations et générations T6, demandes T2 (sans contenu conversationnel).' },
  preuves: { label: 'Preuves et provenance', description: 'Preuves de champ (document, page, extrait, valeur, confiance, traitement producteur, cycle de vie).' },
  candidats: { label: 'Candidats', description: 'Valeurs et objets candidats, y compris rejetés : candidats de rapprochement T1 et décision T3, propositions, faits non résolus, examens de candidats T6.' },
  'conflits-arbitrages': { label: 'Conflits et arbitrages', description: 'Passages et décisions de réconciliation T3 (action, motif, preuves citées), registre des incohérences (valeur existante / proposée, preuves), contrôles « Informations », décisions de rapprochement, revues d’identité, réévaluations sémantiques T3 / T4, conflits d’agenda.' },
  ecritures: { label: 'Écritures et persistance', description: 'Écritures canoniques (avant / après, résultat, trace), mises à jour IA (et retours arrière), lignes des rapports d’exécution (écriture prévue / confirmée / refusée), versions d’objets, actions de l’assistant (plans, exécutions, annulations).' },
  'corrections-utilisateur': { label: 'Corrections utilisateur et verrouillages', description: 'Décisions utilisateur (TCO, « À traiter »), corrections bien / équipement, retours de classement, suppressions de projection, remédiations ; verrouillages portés par les fiches (`__userValidated`, origine USER) dans l’état métier.' },
  'rapprochements-agenda-controles': { label: 'Rapprochements, agenda, contrôles et autoréparations', description: 'Reconsolidations ciblées, occurrences, consolidations et retraits d’agenda, cartes « À traiter », campagnes / preuves / réparations du contrôle de cohérence, reconstructions et nettoyages BO, changements de connaissance.' },
  historique: { label: 'Historique', description: 'Historique des rapprochements, du compte, des abonnements, renommages et titres, transferts, demandes de suppression, journal Duo, demandes RGPD.' },
  technique: { label: 'Technique', description: 'File des traitements (tentatives, erreurs, résultat), appels IA (modèle, rang, prompt maître et version, durée, coût), opérations et étapes IA, diagnostics et captures d’appels (métadonnées, empreintes), anomalies, notifications, versions applicatives, migrations appliquées, indicateurs de fonctionnement.' },
  referentiels: { label: 'Référentiels et configuration', description: 'Référentiels (types, catégories) et configuration IA par empreinte (versions, révisions, prompts maîtres sans leur texte), tâches planifiées : nécessaires pour interpréter les codes et les versions.' },
  'api-ui': { label: 'API et affichage', description: 'Pour chaque propriété de fiche : valeur persistée → valeur renvoyée par le lecteur API (même fonction que la route) → champ consommé par l’écran (table de correspondance maintenue dans le code).' },
  tracabilite: { label: 'Traçabilité des propriétés', description: 'Chaîne par propriété : valeur persistée → décisions → preuves (candidates) → faits → extractions → documents → traitements, conflits et écritures corrélés.' },
  controle: { label: 'Auto-contrôle', description: 'Fermeture transitive (références résolues, ajoutées hors périmètre direct, absentes), compteurs annoncés vs lignes détaillées, couverture des tables.' },
  'non-classees': { label: 'Tables non classées', description: 'Tables présentes en base, absentes du registre : exportées par prudence si elles portent `account_id`, à classer.' },
};

/** Ordre de présentation des sections (manifeste, guide). */
export const DIAG_SECTION_ORDER = Object.keys(DIAG_SECTIONS) as DiagSectionCode[];

export interface DiagTableCoverage {
  section: DiagSectionCode;
  /**
   * Filtre SQL d'appartenance au compte (`{{A}}` = identifiant du compte),
   * appliqué à la table aliasée `t`. Absent : `t.account_id = {{A}}`.
   */
  filter?: string;
  /** Table sans donnée de compte (référentiel, configuration) : cible de la fermeture transitive. */
  global?: boolean;
  /**
   * Des références depuis le compte peuvent légitimement viser des lignes
   * hors compte (acteurs administrateurs, compte cible d'un transfert) :
   * identifiant seul, non exporté, jamais compté comme manquant.
   */
  externalRefs?: string;
}

const ASSETS = `(SELECT a.id FROM assets a WHERE a.account_id = {{A}})`;
const FILES = `(SELECT f.id FROM asset_files f WHERE f.account_id = {{A}})`;
const OPS = `(SELECT o.id FROM business_operations o WHERE o.account_id = {{A}})`;
const AGENDA = `(SELECT i.id FROM agenda_items i WHERE i.account_id = {{A}})`;
const EQUIPMENTS = `(SELECT e.id FROM equipments e WHERE e.asset_id IN ${ASSETS})`;
const SUPPLIERS = `(SELECT s.id FROM suppliers s WHERE s.account_id = {{A}})`;
const MEMBERS = `(SELECT m.user_id FROM account_memberships m WHERE m.account_id = {{A}})`;

const C = (section: DiagSectionCode, extra: Omit<DiagTableCoverage, 'section'> = {}): DiagTableCoverage => ({ section, ...extra });

/** Tables COUVERTES : section et filtre d'appartenance au compte. */
export const DIAG_TABLE_COVERAGE: Readonly<Record<string, DiagTableCoverage>> = {
  // ── État métier ──────────────────────────────────────────────────────────
  accounts: C('etat-metier', { filter: 't.id = {{A}}', externalRefs: 'comptes cibles d’un transfert ou d’un Duo : identifiant seul' }),
  users: C('etat-metier', { filter: `t.id IN ${MEMBERS}`, externalRefs: 'acteurs hors compte (administrateurs BO, membres retirés) : identifiant seul' }),
  account_memberships: C('etat-metier'),
  account_subscriptions: C('etat-metier'),
  trial_grants: C('etat-metier'),
  duo_accounts: C('etat-metier'),
  duo_memberships: C('etat-metier', { filter: 't.duo_id IN (SELECT d.id FROM duo_accounts d WHERE d.account_id = {{A}})' }),
  account_processing_states: C('etat-metier'),
  account_analysis_counters: C('etat-metier'),
  account_analysis_credits: C('etat-metier'),
  scheduled_account_deletions: C('etat-metier'),
  invoices: C('etat-metier'),
  billing_price_operations: C('etat-metier'),
  subscription_communication_operations: C('etat-metier'),
  stripe_price_migrations: C('etat-metier'),
  assets: C('etat-metier'),
  asset_additional_infos: C('etat-metier'),
  asset_cil_profiles: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  asset_custom_field_values: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  asset_photos: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  asset_suppliers: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  asset_transmissions: C('etat-metier'),
  asset_usage_budgets: C('etat-metier'),
  cil_block_resolutions: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  energy_materials: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  energy_works: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  suppliers: C('etat-metier'),
  supplier_review_items: C('etat-metier'),
  supplier_contact_observations: C('etat-metier', { filter: `t.supplier_id IN ${SUPPLIERS}` }),
  substructures: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  rooms: C('etat-metier'),
  equipments: C('etat-metier', { filter: `t.asset_id IN ${ASSETS}` }),
  equipment_cil_specs: C('etat-metier', { filter: `t.equipment_id IN ${EQUIPMENTS}` }),
  equipment_suppliers: C('etat-metier', { filter: `t.equipment_id IN ${EQUIPMENTS}` }),
  business_operations: C('etat-metier'),
  business_operation_contract_details: C('etat-metier', { filter: `t.operation_id IN ${OPS}` }),
  business_operation_financing_details: C('etat-metier', { filter: `t.operation_id IN ${OPS}` }),
  business_operation_claim_details: C('etat-metier', { filter: `t.operation_id IN ${OPS}` }),
  business_operation_claim_damages: C('etat-metier', { filter: `t.operation_id IN ${OPS}` }),
  business_operation_claim_damage_documents: C('etat-metier', { filter: `t.file_id IN ${FILES}` }),
  business_operation_claim_damage_photos: C('etat-metier', { filter: `t.damage_id IN (SELECT d.id FROM business_operation_claim_damages d WHERE d.operation_id IN ${OPS})` }),
  business_operation_claim_actions: C('etat-metier', { filter: `t.operation_id IN ${OPS}` }),
  business_operation_claim_exchanges: C('etat-metier', { filter: `t.operation_id IN ${OPS}` }),
  business_operation_claim_migration_marks: C('etat-metier'),
  business_operation_financial_components: C('etat-metier'),
  business_operation_side_amounts: C('etat-metier'),
  business_operation_references: C('etat-metier'),
  agenda_items: C('etat-metier'),
  deadlines: C('etat-metier'),
  events: C('etat-metier'),
  calendar_additions: C('etat-metier'),
  t6_reminder_preferences: C('etat-metier'),
  export_generation: C('etat-metier'),
  // ── Documents ────────────────────────────────────────────────────────────
  asset_files: C('documents'),
  documents: C('documents', { filter: `t.asset_id IN ${ASSETS}` }),
  document_versions: C('documents'),
  asset_file_thumbnails: C('documents'),
  document_cil_metadata: C('documents', { filter: `t.asset_file_id IN ${FILES}` }),
  document_lots: C('documents'),
  document_lot_items: C('documents', { filter: `t.asset_file_id IN ${FILES}` }),
  document_naming_groups: C('documents'),
  document_naming_members: C('documents'),
  document_validation_reprise: C('documents'),
  document_suppliers: C('documents', { filter: `t.document_id IN ${FILES}` }),
  event_documents: C('documents', { filter: `t.file_id IN ${FILES}` }),
  // ── Relations ────────────────────────────────────────────────────────────
  document_asset_links: C('relations'),
  document_asset_resolutions: C('relations'),
  document_asset_identifier_changes: C('relations'),
  business_operation_sources: C('relations'),
  business_operation_documents: C('relations'),
  business_operation_asset_links: C('relations'),
  business_operation_equipment_links: C('relations'),
  business_operation_room_links: C('relations'),
  business_operation_asset_exclusions: C('relations'),
  business_operation_asset_data_marks: C('relations'),
  business_operation_financial_component_sources: C('relations', { filter: `t.component_id IN (SELECT c.id FROM business_operation_financial_components c WHERE c.account_id = {{A}})` }),
  agenda_asset_links: C('relations', { filter: `t.agenda_item_id IN ${AGENDA}` }),
  agenda_equipment_links: C('relations', { filter: `t.agenda_item_id IN ${AGENDA}` }),
  agenda_file_links: C('relations', { filter: `t.agenda_item_id IN ${AGENDA}` }),
  agenda_room_links: C('relations', { filter: `t.agenda_item_id IN ${AGENDA}` }),
  agenda_item_sources: C('relations', { filter: `t.agenda_item_id IN ${AGENDA}` }),
  // ── Extractions IA ───────────────────────────────────────────────────────
  document_raw_extracts: C('extractions-ia'),
  document_extractions: C('extractions-ia'),
  document_extraction_coverage: C('extractions-ia'),
  document_facts: C('extractions-ia'),
  document_source_units: C('extractions-ia'),
  document_tables: C('extractions-ia'),
  document_table_cells: C('extractions-ia'),
  document_analysis_runs: C('extractions-ia'),
  document_field_values: C('extractions-ia'),
  document_rule_evaluations: C('extractions-ia'),
  t1_quality_signals: C('extractions-ia'),
  ai_execution_reports: C('extractions-ia'),
  t3_knowledge_queries: C('extractions-ia'),
  t6_evaluation_runs: C('extractions-ia'),
  t6_interpellation_assessments: C('extractions-ia'),
  home_mascot_generations: C('extractions-ia'),
  home_mascot_events: C('extractions-ia'),
  home_mascot_acknowledgments: C('extractions-ia'),
  home_mascot_cache: C('extractions-ia'),
  home_mascot_pregen_requests: C('extractions-ia'),
  verebona_request_runs: C('extractions-ia'),
  verebona_ai_runs: C('extractions-ia'),
  verebona_fact_revalidations: C('extractions-ia'),
  ai_output_replays: C('extractions-ia'),
  // ── Preuves ──────────────────────────────────────────────────────────────
  field_evidence: C('preuves'),
  // ── Candidats ────────────────────────────────────────────────────────────
  document_operation_candidates: C('candidats'),
  document_analysis_proposals: C('candidats'),
  document_unresolved_facts: C('candidats'),
  t6_candidate_examinations: C('candidats'),
  // ── Conflits et arbitrages ───────────────────────────────────────────────
  reconciliation_runs: C('conflits-arbitrages'),
  reconciliation_decisions: C('conflits-arbitrages'),
  account_reconciliation_runs: C('conflits-arbitrages'),
  inconsistency_registry: C('conflits-arbitrages'),
  t3_information_checks: C('conflits-arbitrages'),
  t3_reconciliation_states: C('conflits-arbitrages'),
  t3_open_action_evaluations: C('conflits-arbitrages'),
  agenda_data_conflicts: C('conflits-arbitrages'),
  business_operation_match_decisions: C('conflits-arbitrages'),
  business_operation_identity_reviews: C('conflits-arbitrages'),
  operation_semantic_reevaluations: C('conflits-arbitrages'),
  // ── Écritures ────────────────────────────────────────────────────────────
  canonical_field_writes: C('ecritures'),
  property_recovery_runs: C('conflits-arbitrages'),
  property_recovery_decisions: C('ecritures'),
  ai_field_updates: C('ecritures'),
  object_versions: C('ecritures'),
  ai_execution_report_entries: C('ecritures'),
  impact_queue: C('ecritures'),
  field_origin_migration_audit: C('ecritures'),
  verebona_command_plans: C('ecritures'),
  verebona_command_events: C('ecritures'),
  verebona_command_undo_steps: C('ecritures'),
  // ── Corrections utilisateur ──────────────────────────────────────────────
  data_separation_corrections: C('corrections-utilisateur'),
  asset_cost_line_decisions: C('corrections-utilisateur'),
  asset_cost_line_decision_events: C('corrections-utilisateur'),
  to_process_decisions: C('corrections-utilisateur'),
  document_classification_feedback: C('corrections-utilisateur', { filter: `t.file_id IN ${FILES}` }),
  business_operation_projection_suppressions: C('corrections-utilisateur'),
  cross_account_remediations: C('corrections-utilisateur'),
  // ── Rapprochements, agenda, contrôles ────────────────────────────────────
  business_operation_targeted_runs: C('rapprochements-agenda-controles'),
  agenda_occurrence_events: C('rapprochements-agenda-controles'),
  agenda_intervention_consolidations: C('rapprochements-agenda-controles'),
  agenda_item_removals: C('rapprochements-agenda-controles'),
  annual_renewal_reminder_checks: C('rapprochements-agenda-controles'),
  coherence_object_proofs: C('rapprochements-agenda-controles'),
  coherence_repairs: C('rapprochements-agenda-controles'),
  coherence_campaigns: C('rapprochements-agenda-controles', {
    global: true,
    filter: `t.id IN (SELECT r.campaign_id FROM coherence_repairs r WHERE r.account_id = {{A}} UNION SELECT p.last_campaign_id FROM coherence_object_proofs p WHERE p.account_id = {{A}})`,
  }),
  account_knowledge_changes: C('rapprochements-agenda-controles'),
  to_process_actions: C('rapprochements-agenda-controles'),
  to_process_action_events: C('rapprochements-agenda-controles'),
  to_process_item_state: C('rapprochements-agenda-controles'),
  to_process_evaluation_passages: C('rapprochements-agenda-controles'),
  to_process_trace_retries: C('rapprochements-agenda-controles'),
  to_process_digest_state: C('rapprochements-agenda-controles'),
  to_process_relevance_campaign_items: C('rapprochements-agenda-controles'),
  to_process_relevance_recette_runs: C('rapprochements-agenda-controles'),
  to_process_relevance_campaigns: C('rapprochements-agenda-controles', { global: true, filter: 't.id IN (SELECT i.campaign_id FROM to_process_relevance_campaign_items i WHERE i.account_id = {{A}})' }),
  operations_rebuild_accounts: C('rapprochements-agenda-controles'),
  operations_rebuild_snapshots: C('rapprochements-agenda-controles'),
  operations_rebuild_runs: C('rapprochements-agenda-controles', { global: true, filter: 't.id IN (SELECT r.run_id FROM operations_rebuild_accounts r WHERE r.account_id = {{A}})' }),
  claim_legacy_cleanup_journal: C('rapprochements-agenda-controles'),
  claim_legacy_cleanup_runs: C('rapprochements-agenda-controles', { global: true, filter: 't.id IN (SELECT j.run_id FROM claim_legacy_cleanup_journal j WHERE j.account_id = {{A}})' }),
  room_merge_runs: C('rapprochements-agenda-controles'),
  room_merge_changes: C('rapprochements-agenda-controles'),
  cdc15_migration_runs: C('rapprochements-agenda-controles'),
  cdc15_migration_report: C('rapprochements-agenda-controles'),
  cdc15_migration_backups: C('rapprochements-agenda-controles'),
  // ── Historique ───────────────────────────────────────────────────────────
  business_operation_history: C('historique'),
  subscription_history: C('historique'),
  account_audit_log: C('historique'),
  document_rename_events: C('historique'),
  document_title_events: C('historique'),
  duo_shared_account_journal: C('historique'),
  asset_space_moves: C('historique', { filter: `t.asset_id IN ${ASSETS} OR t.from_account_id = {{A}} OR t.to_account_id = {{A}}` }),
  asset_move_requests: C('historique', { filter: `t.asset_id IN ${ASSETS} OR t.target_account_id = {{A}}` }),
  asset_delete_requests: C('historique', { filter: `t.asset_id IN ${ASSETS}` }),
  gdpr_requests: C('historique'),
  gdpr_exports: C('historique'),
  withdrawal_requests: C('historique'),
  // ── Technique ────────────────────────────────────────────────────────────
  ai_job_queue: C('technique'),
  ai_t3_enqueue_events: C('technique'),
  ai_usage_event: C('technique'),
  ai_usage_events: C('technique'),
  ai_usage_daily_rollup: C('technique'),
  ai_usage_account_counter: C('technique'),
  ai_operation: C('technique'),
  ai_pipeline_step: C('technique', { filter: 't.operation_id IN (SELECT o.id FROM ai_operation o WHERE o.account_id = {{A}})' }),
  ai_analysis_version: C('technique', { filter: `t.asset_file_id IN ${FILES}` }),
  ai_call_diagnostics: C('technique'),
  ai_call_captures: C('technique'),
  ai_search_log: C('technique'),
  ai_security_lock: C('technique'),
  ai_account_cost_caps: C('technique'),
  ai_alerts: C('technique'),
  ai_t2_content_access_log: C('technique'),
  admin_anomalies: C('technique'),
  admin_anomaly_occurrences: C('technique'),
  admin_export_generations: C('technique', { filter: 't.target_account_id = {{A}}' }),
  notification_events: C('technique'),
  notification_outbox: C('technique'),
  notifications: C('technique', { filter: `t.user_id IN ${MEMBERS}` }),
  notification_deliveries: C('technique', { filter: `t.user_id IN ${MEMBERS}` }),
  notification_preferences: C('technique', { filter: `t.user_id IN ${MEMBERS}` }),
  _migrations: C('technique', { global: true, filter: 'TRUE' }),
  scheduled_task_state: C('technique', { global: true, filter: 'TRUE' }),
  ai_queue_worker_heartbeats: C('technique', { global: true, filter: 'TRUE' }),
  ai_treatment_state: C('technique', { global: true, filter: 'TRUE' }),
  // ── Référentiels et configuration (globaux, cibles de la fermeture) ──────
  asset_types: C('referentiels', { global: true, filter: 'TRUE' }),
  asset_type_subcategories: C('referentiels', { global: true, filter: 'TRUE' }),
  asset_custom_fields: C('referentiels', { global: true, filter: 'TRUE' }),
  document_types: C('referentiels', { global: true, filter: 'TRUE' }),
  document_categories: C('referentiels', { global: true, filter: 'TRUE' }),
  document_category_asset_associations: C('referentiels', { global: true, filter: 'TRUE' }),
  document_category_type_associations: C('referentiels', { global: true, filter: 'TRUE' }),
  document_type_asset_associations: C('referentiels', { global: true, filter: 'TRUE' }),
  document_type_export_associations: C('referentiels', { global: true, filter: 'TRUE' }),
  document_taxonomy_mappings: C('referentiels', { global: true, filter: 'TRUE' }),
  document_reference_corrections: C('referentiels', { global: true, filter: 'TRUE' }),
  business_operation_types: C('referentiels', { global: true, filter: 'TRUE' }),
  field_dependencies: C('referentiels', { global: true, filter: 'TRUE' }),
  ai_use_cases: C('referentiels', { global: true, filter: 'TRUE' }),
  ai_operations: C('referentiels', { global: true, filter: 'TRUE' }),
  ai_pipeline_version: C('referentiels', { global: true, filter: 'TRUE' }),
  ai_config_versions: C('referentiels', { global: true, filter: 'TRUE' }),
  ai_config_revisions: C('referentiels', { global: true, filter: 'TRUE' }),
  ai_config_entries: C('referentiels', { global: true, filter: 'TRUE' }),
  ai_master_prompt_versions: C('referentiels', { global: true, filter: 'TRUE' }),
  ai_prompt_versions: C('referentiels', { global: true, filter: 'TRUE' }),
};

type DiagExclusionCategory = 'SECURITE' | 'CONTENU_PERSONNEL' | 'HORS_COMPTE' | 'COMMERCIAL' | 'TECHNIQUE';

/** Tables EXCLUES : catégorie et motif (manifeste, guide). */
export const DIAG_TABLE_EXCLUSIONS: Readonly<Record<string, { category: DiagExclusionCategory; motif: string }>> = {
  // Sécurité : secrets, sessions, jetons.
  auth_rate_limits: { category: 'SECURITE', motif: 'limitation des connexions (sécurité)' },
  revoked_tokens: { category: 'SECURITE', motif: 'jetons révoqués' },
  user_session_revocations: { category: 'SECURITE', motif: 'révocations de sessions' },
  idempotency_keys: { category: 'SECURITE', motif: 'empreintes et corps de requêtes rejouables' },
  ai_provider_credential: { category: 'SECURITE', motif: 'secret fournisseur IA' },
  withdrawal_verification_tokens: { category: 'SECURITE', motif: 'jetons de vérification (rétractation)' },
  push_subscriptions: { category: 'SECURITE', motif: 'abonnements push (points d’accès et clés)' },
  account_isolation_checks: { category: 'SECURITE', motif: 'contrôle d’isolation multi-comptes (BO › Isolation des comptes)' },
  // Contenu conversationnel personnel (assistant T2) : métadonnées des demandes exportées (verebona_request_runs, verebona_ai_runs).
  verebona_conversations: { category: 'CONTENU_PERSONNEL', motif: 'conversations de l’assistant (contenu personnel) — demandes exportées sans contenu (verebona_request_runs)' },
  verebona_messages: { category: 'CONTENU_PERSONNEL', motif: 'messages de l’assistant (contenu personnel)' },
  verebona_message_actions: { category: 'CONTENU_PERSONNEL', motif: 'assistant : actions proposées dans un message' },
  verebona_message_claims: { category: 'CONTENU_PERSONNEL', motif: 'assistant : affirmations d’un message' },
  verebona_message_sources: { category: 'CONTENU_PERSONNEL', motif: 'assistant : sources d’un message' },
  verebona_presented_entities: { category: 'CONTENU_PERSONNEL', motif: 'assistant : entités présentées' },
  verebona_clarification_events: { category: 'CONTENU_PERSONNEL', motif: 'assistant : demandes de précision' },
  verebona_feedback: { category: 'CONTENU_PERSONNEL', motif: 'assistant : avis de l’utilisateur' },
  verebona_claim_sources: { category: 'CONTENU_PERSONNEL', motif: 'assistant : sources d’affirmations' },
  verebona_assistant_settings: { category: 'TECHNIQUE', motif: 'assistant : réglages globaux' },
  verebona_assistant_setting_requests: { category: 'TECHNIQUE', motif: 'assistant : demandes de réglage globales' },
  verebona_cache_versions: { category: 'TECHNIQUE', motif: 'assistant : versions de cache' },
  verebona_help_entries: { category: 'TECHNIQUE', motif: 'assistant : aide en ligne' },
  verebona_rate_limit_counters: { category: 'TECHNIQUE', motif: 'assistant : limitation de débit' },
  verebona_usage_events: { category: 'TECHNIQUE', motif: 'assistant : journal sans compte (consommation exportée par verebona_ai_runs)' },
  // Journaux multi-comptes ou sans rattachement fiable au compte.
  admin_audit_log: { category: 'HORS_COMPTE', motif: 'journal d’administration BO (BO › Journal) : pas de rattachement fiable au compte' },
  ai_admin_audit_log: { category: 'HORS_COMPTE', motif: 'journal d’administration IA' },
  ops_backfill_runs: { category: 'HORS_COMPTE', motif: 'rattrapages BO multi-comptes' },
  agenda_intervention_reprise_runs: { category: 'HORS_COMPTE', motif: 'reprise multi-comptes des doublons d’agenda' },
  to_process_arbitration_reprises: { category: 'HORS_COMPTE', motif: 'reprise multi-comptes (curseurs)' },
  to_process_digest_runs: { category: 'HORS_COMPTE', motif: 'récapitulatifs multi-comptes (curseurs)' },
  to_process_scan_runs: { category: 'HORS_COMPTE', motif: 'balayages multi-comptes (comptes en échec)' },
  to_process_config_baselines: { category: 'TECHNIQUE', motif: 'empreintes de configuration « À traiter »' },
  annual_renewal_reminder_state: { category: 'HORS_COMPTE', motif: 'état global du rappel annuel' },
  ai_log_archives: { category: 'HORS_COMPTE', motif: 'archives des journaux IA (fichiers multi-comptes)' },
  ai_retired_treatment_archive: { category: 'HORS_COMPTE', motif: 'archives de traitements retirés (multi-comptes)' },
  migration_0250_unpaid_backup: { category: 'HORS_COMPTE', motif: 'sauvegarde technique d’une migration' },
  pending_blob_deletions: { category: 'HORS_COMPTE', motif: 'file de suppression du stockage (emplacements de stockage)' },
  job_locks: { category: 'TECHNIQUE', motif: 'baux des tâches (instantanés sans historique)' },
  ai_call_capture_state: { category: 'TECHNIQUE', motif: 'configuration de la capture IA' },
  ai_operation_idempotency: { category: 'TECHNIQUE', motif: 'idempotence IA (résultats rejouables)' },
  t6_evaluation_signature_baselines: { category: 'TECHNIQUE', motif: 'références de signature T6 (globales)' },
  ai_evaluator_runs: { category: 'TECHNIQUE', motif: 'horodatage des évaluateurs IA' },
  ai_legacy_usage_mapping: { category: 'TECHNIQUE', motif: 'correspondance des anciens usages IA' },
  // Configuration et qualification IA hors traitement du compte (les versions utilisées sont exportées par empreinte).
  ai_config_exports: { category: 'TECHNIQUE', motif: 'exports de configuration IA (contenu complet)' },
  ai_config_packages: { category: 'TECHNIQUE', motif: 'paquets de configuration IA (contenu complet)' },
  ai_config_imports: { category: 'TECHNIQUE', motif: 'imports de configuration IA (contenu complet)' },
  ai_config_interventions: { category: 'TECHNIQUE', motif: 'interventions manuelles sur le routage IA (globales)' },
  ai_routing_promotions: { category: 'TECHNIQUE', motif: 'routage IA subordonné (global)' },
  ai_cost_anomaly_settings: { category: 'TECHNIQUE', motif: 'réglages de coûts IA' },
  ai_cost_settings: { category: 'TECHNIQUE', motif: 'réglages de coûts IA' },
  ai_emergency_stop: { category: 'TECHNIQUE', motif: 'arrêt d’urgence IA (global)' },
  ai_instructions: { category: 'TECHNIQUE', motif: 'instructions de prompts (texte)' },
  ai_master_corpus_runs: { category: 'TECHNIQUE', motif: 'qualification IA (corpus)' },
  ai_master_prompt_activations: { category: 'TECHNIQUE', motif: 'journal d’activation des prompts maîtres (versions exportées par empreinte)' },
  ai_master_prompt_test_runs: { category: 'TECHNIQUE', motif: 'qualification IA (tests de prompts)' },
  ai_prompt_change_requests: { category: 'TECHNIQUE', motif: 'demandes de changement de prompt (texte)' },
  ai_prompt_test_runs: { category: 'TECHNIQUE', motif: 'qualification IA (tests de prompts)' },
  ai_model_catalog: { category: 'TECHNIQUE', motif: 'catalogue des modèles (les modèles utilisés figurent dans chaque appel)' },
  ai_model_catalog_refresh: { category: 'TECHNIQUE', motif: 'catalogue des modèles' },
  ai_model_operational_status: { category: 'TECHNIQUE', motif: 'catalogue des modèles' },
  ai_model_price_changes: { category: 'TECHNIQUE', motif: 'tarifs des modèles' },
  ai_model_price_status: { category: 'TECHNIQUE', motif: 'tarifs des modèles' },
  ai_model_pricing: { category: 'TECHNIQUE', motif: 'tarifs des modèles' },
  ai_model_pricing_refresh_log: { category: 'TECHNIQUE', motif: 'tarifs des modèles' },
  ai_model_qualification: { category: 'TECHNIQUE', motif: 'qualification des modèles' },
  ai_model_capability_changes: { category: 'TECHNIQUE', motif: 'capacités des modèles (globales)' },
  ai_qualification_campaigns: { category: 'TECHNIQUE', motif: 'qualification IA par couple (globale)' },
  ai_qualification_campaign_accounts: { category: 'TECHNIQUE', motif: 'qualification IA : verrous de compte (aucune donnée métier)' },
  ai_qualification_evidence: { category: 'TECHNIQUE', motif: 'qualification IA par couple (globale)' },
  ai_qualification_cases: { category: 'TECHNIQUE', motif: 'qualification IA : résultats par cas (empreintes)' },
  ai_corpus_baseline: { category: 'TECHNIQUE', motif: 'ancien harnais de mesure retiré (table inerte)' },
  // Commercial, communication, juridique : hors diagnostic fonctionnel du compte.
  analysis_packs: { category: 'COMMERCIAL', motif: 'catalogue commercial' },
  plan_configs: { category: 'COMMERCIAL', motif: 'catalogue commercial' },
  plan_limits: { category: 'COMMERCIAL', motif: 'catalogue commercial' },
  promo_codes: { category: 'COMMERCIAL', motif: 'catalogue commercial' },
  subscription_plans: { category: 'COMMERCIAL', motif: 'catalogue commercial' },
  dunning_events: { category: 'COMMERCIAL', motif: 'relances de paiement (Stripe, sans compte)' },
  stripe_catalog_products: { category: 'COMMERCIAL', motif: 'Stripe (catalogue)' },
  stripe_catalog_recoveries: { category: 'COMMERCIAL', motif: 'Stripe (catalogue)' },
  stripe_catalog_runs: { category: 'COMMERCIAL', motif: 'Stripe (catalogue)' },
  stripe_catalog_state: { category: 'COMMERCIAL', motif: 'Stripe (catalogue)' },
  stripe_invoice_effects: { category: 'COMMERCIAL', motif: 'Stripe (effets de factures, sans compte)' },
  stripe_price_versions: { category: 'COMMERCIAL', motif: 'Stripe (prix)' },
  stripe_webhook_logs: { category: 'COMMERCIAL', motif: 'Stripe (journal des webhooks multi-comptes)' },
  referral_email_sends: { category: 'COMMERCIAL', motif: 'parrainage' },
  referral_events: { category: 'COMMERCIAL', motif: 'parrainage' },
  referral_links: { category: 'COMMERCIAL', motif: 'parrainage' },
  funnel_events: { category: 'COMMERCIAL', motif: 'statistiques de conversion' },
  signup_contexts: { category: 'COMMERCIAL', motif: 'statistiques d’inscription' },
  user_activity_log: { category: 'HORS_COMPTE', motif: 'journal d’activité des utilisateurs (adresses IP, navigateurs)' },
  user_guide_progress: { category: 'COMMERCIAL', motif: 'progression du guide' },
  news_consents: { category: 'COMMERCIAL', motif: 'consentements de communication' },
  help_article_feedback: { category: 'COMMERCIAL', motif: 'aide en ligne' },
  email_logs: { category: 'HORS_COMPTE', motif: 'journal des e-mails (BO › E-mails ; destinataires)' },
  email_provider_events: { category: 'HORS_COMPTE', motif: 'journal du fournisseur d’e-mails' },
  email_settings: { category: 'TECHNIQUE', motif: 'configuration e-mail' },
  email_template_versions: { category: 'TECHNIQUE', motif: 'modèles d’e-mails' },
  email_templates: { category: 'TECHNIQUE', motif: 'modèles d’e-mails' },
  communication_channel_settings: { category: 'TECHNIQUE', motif: 'configuration des canaux' },
  transactional_email_jobs: { category: 'HORS_COMPTE', motif: 'file des e-mails transactionnels (destinataires, sans compte)' },
  legal_acceptances: { category: 'COMMERCIAL', motif: 'juridique' },
  legal_audit_log: { category: 'COMMERCIAL', motif: 'juridique' },
  legal_document_versions: { category: 'COMMERCIAL', motif: 'juridique' },
  withdrawal_events: { category: 'COMMERCIAL', motif: 'rétractation (journal sans compte)' },
  export_generation_items: { category: 'TECHNIQUE', motif: 'dossiers V12 : éléments (générations exportées dans export_generation)' },
  export_generation_logs: { category: 'TECHNIQUE', motif: 'dossiers V12 : journaux' },
  export_templates: { category: 'TECHNIQUE', motif: 'modèles d’export V12' },
  export_dossier_availability: { category: 'TECHNIQUE', motif: 'disponibilité des dossiers V12' },
  system_files: { category: 'TECHNIQUE', motif: 'fichiers système' },
  system_logos: { category: 'TECHNIQUE', motif: 'logos système' },
};

interface DiagTableClassification {
  covered: Array<{ table: string } & DiagTableCoverage>;
  excluded: Array<{ table: string; category: DiagExclusionCategory; motif: string }>;
  /** Présentes, non déclarées (à classer) : exportées par prudence si elles portent account_id. */
  unclassified: string[];
  /** Déclarées, absentes de la base (table retirée ou migration non appliquée). */
  missing: string[];
}

/** Tables déclarées qui peuvent légitimement être absentes (ancien modèle supprimé par une finalisation BO). */
const DIAG_RETIRABLE_TABLES: ReadonlySet<string> = new Set([
  'business_operation_claim_actions', 'business_operation_claim_exchanges', 'business_operation_claim_migration_marks', 'ai_corpus_baseline',
]);

export function classifyDiagTables(dbTables: readonly string[]): DiagTableClassification {
  const present = new Set(dbTables);
  const out: DiagTableClassification = { covered: [], excluded: [], unclassified: [], missing: [] };
  for (const t of [...dbTables].sort()) {
    const c = DIAG_TABLE_COVERAGE[t];
    if (c) out.covered.push({ table: t, ...c });
    else if (DIAG_TABLE_EXCLUSIONS[t]) out.excluded.push({ table: t, ...DIAG_TABLE_EXCLUSIONS[t] });
    else out.unclassified.push(t);
  }
  out.missing = [...Object.keys(DIAG_TABLE_COVERAGE), ...Object.keys(DIAG_TABLE_EXCLUSIONS)]
    .filter((t) => !present.has(t) && !DIAG_RETIRABLE_TABLES.has(t)).sort();
  return out;
}

/** Filtre SQL effectif d'une table couverte (alias `t`). */
export function coverageFilter(c: DiagTableCoverage): string {
  return c.filter ?? 't.account_id = {{A}}';
}

// ── Références logiques (au-delà des clés étrangères du catalogue) ─────────

/**
 * Référence logique : la colonne `column` de `from` désigne une ligne de
 * `to` (clé `toColumn`, défaut `id`). `kind` : valeur simple, tableau JSON
 * ou tableau PostgreSQL ; `when` : condition SQL sur la ligne source (alias
 * `t`) pour les références polymorphes. Les clés étrangères DÉCLARÉES en base
 * sont ajoutées automatiquement (catalogue `pg_constraint`).
 */
interface DiagLogicalReference {
  from: string;
  column: string;
  to: string;
  toColumn?: string;
  kind?: 'value' | 'json-array' | 'pg-array';
  when?: string;
  role: string;
}

export const DIAG_LOGICAL_REFERENCES: readonly DiagLogicalReference[] = [
  // Propriété → décision → candidat (preuve) → fait → extraction → document → traitement.
  { from: 'reconciliation_decisions', column: 'run_id', to: 'reconciliation_runs', role: 'décision → passage T3' },
  { from: 'reconciliation_decisions', column: 'evidence_ids', to: 'field_evidence', kind: 'json-array', role: 'décision → preuves candidates' },
  { from: 'inconsistency_registry', column: 'current_evidence_ids', to: 'field_evidence', kind: 'json-array', role: 'conflit → preuves de la valeur existante' },
  { from: 'inconsistency_registry', column: 'proposed_evidence_ids', to: 'field_evidence', kind: 'json-array', role: 'conflit → preuves de la valeur proposée' },
  { from: 'property_recovery_decisions', column: 'evidence_ids', to: 'field_evidence', kind: 'pg-array', role: 'propriété manquante → preuves créées ou citées' },
  { from: 'field_evidence', column: 'source_id', to: 'asset_files', when: `lower(t.source_type) IN ('document', 'file', 'asset_file')`, role: 'preuve → document source' },
  { from: 'field_evidence', column: 'superseded_by_evidence_id', to: 'field_evidence', role: 'preuve → preuve remplaçante' },
  { from: 'field_evidence', column: 'analysis_run_id', to: 'document_analysis_runs', role: 'preuve → analyse productrice' },
  { from: 'field_evidence', column: 'asset_id', to: 'assets', role: 'preuve → bien' },
  { from: 'document_facts', column: 'extraction_id', to: 'document_extractions', role: 'fait → extraction T1' },
  { from: 'document_facts', column: 'file_id', to: 'asset_files', role: 'fait → document' },
  { from: 'document_facts', column: 'source_unit_ids', to: 'document_source_units', toColumn: 'source_unit_id', kind: 'pg-array', role: 'fait → unités sources (entrée utile)' },
  { from: 'document_extractions', column: 'file_id', to: 'asset_files', role: 'extraction → document' },
  { from: 'document_extractions', column: 'analysis_run_id', to: 'document_analysis_runs', role: 'extraction → analyse' },
  { from: 'document_source_units', column: 'extraction_id', to: 'document_extractions', role: 'unité source → extraction' },
  { from: 'document_operation_candidates', column: 'extraction_id', to: 'document_extractions', role: 'candidat → extraction' },
  { from: 'document_operation_candidates', column: 'file_id', to: 'asset_files', role: 'candidat → document' },
  { from: 'document_operation_candidates', column: 't3_operation_id', to: 'business_operations', role: 'candidat → rapprochement retenu (T3)' },
  { from: 'canonical_field_writes', column: 'asset_id', to: 'assets', role: 'écriture → bien' },
  { from: 'canonical_field_writes', column: 'target_id', to: 'equipments', when: `upper(t.target_type) = 'EQUIPMENT'`, role: 'écriture → équipement' },
  { from: 'ai_field_updates', column: 'evidence_id', to: 'field_evidence', role: 'mise à jour IA → preuve' },
  { from: 'ai_field_updates', column: 'asset_file_id', to: 'asset_files', role: 'mise à jour IA → document' },
  { from: 'ai_execution_report_entries', column: 'report_id', to: 'ai_execution_reports', role: 'ligne de rapport → rapport' },
  { from: 'ai_execution_reports', column: 'file_id', to: 'asset_files', role: 'rapport → document' },
  { from: 'ai_execution_reports', column: 'asset_id', to: 'assets', role: 'rapport → bien' },
  { from: 'ai_execution_reports', column: 'extraction_id', to: 'document_extractions', role: 'rapport → extraction' },
  { from: 'ai_execution_reports', column: 'reconciliation_run_id', to: 'reconciliation_runs', role: 'rapport → passage T3' },
  { from: 'ai_execution_reports', column: 'job_id', to: 'ai_job_queue', role: 'rapport → traitement (file)' },
  { from: 'ai_execution_reports', column: 'origin_t1_report_id', to: 'ai_execution_reports', role: 'rapport T3 → rapport T1 d’origine' },
  { from: 'ai_job_queue', column: 'target_id', to: 'asset_files', when: `lower(t.target_type) IN ('asset_file', 'document')`, role: 'traitement → document cible' },
  { from: 'ai_job_queue', column: 'target_id', to: 'assets', when: `lower(t.target_type) = 'asset'`, role: 'traitement → bien cible' },
  { from: 'ai_job_queue', column: 'config_version_id', to: 'ai_config_versions', role: 'traitement → version de configuration IA' },
  { from: 'ai_usage_event', column: 'job_id', to: 'ai_job_queue', role: 'appel IA → traitement' },
  { from: 'ai_usage_event', column: 'asset_file_id', to: 'asset_files', role: 'appel IA → document' },
  { from: 'ai_usage_event', column: 'config_version_id', to: 'ai_config_versions', role: 'appel IA → version de configuration' },
  { from: 'ai_call_diagnostics', column: 'usage_event_id', to: 'ai_usage_event', role: 'diagnostic d’appel → appel' },
  { from: 'ai_call_captures', column: 'usage_event_id', to: 'ai_usage_event', role: 'capture → appel' },
  // Rapprochements, agenda.
  { from: 'business_operation_sources', column: 'source_entity_key', to: 'asset_files', when: `t.source_kind = 'DOCUMENT' AND t.source_entity_key ~ '^[0-9]{1,9}$'`, role: 'source → document' },
  { from: 'business_operation_history', column: 'source_id', to: 'business_operation_sources', role: 'historique → source' },
  { from: 'business_operation_history', column: 'operation_id', to: 'business_operations', role: 'historique → objet rapproché' },
  { from: 'agenda_item_sources', column: 'evidence_id', to: 'field_evidence', role: 'élément d’agenda → preuve' },
  { from: 'operation_semantic_reevaluations', column: 'operation_id', to: 'business_operations', role: 'réévaluation → objet rapproché' },
  { from: 'operation_semantic_reevaluations', column: 'operation_ids', to: 'business_operations', kind: 'pg-array', role: 'réévaluation → objets rapprochés examinés' },
  { from: 'coherence_repairs', column: 'campaign_id', to: 'coherence_campaigns', role: 'réparation → campagne de cohérence' },
  { from: 'coherence_object_proofs', column: 'last_campaign_id', to: 'coherence_campaigns', role: 'preuve de contrôle → campagne' },
  { from: 't3_knowledge_queries', column: 'file_id', to: 'asset_files', role: 'interprétation T3 → document' },
];

/**
 * Colonnes dont la référence peut légitimement viser une ligne HORS compte
 * (transfert de bien, remédiation d'isolation) : identifiant seul, jamais
 * exporté, jamais compté comme manquant. `table.*` : toutes les colonnes.
 */
const DIAG_EXTERNAL_REFERENCE_COLUMNS: Readonly<Record<string, string>> = {
  'asset_move_requests.asset_id': 'bien transféré vers un autre compte',
  'asset_move_requests.copied_asset_id': 'copie du bien dans le compte cible',
  'asset_space_moves.asset_id': 'bien déplacé vers un autre espace',
  'cross_account_remediations.*': 'remédiation d’isolation : objets d’un autre compte cités par identifiant',
  'duo_accounts.*': 'Premium Duo : compte partenaire',
};

export function isExternalReferenceColumn(table: string, column: string): string | null {
  return DIAG_EXTERNAL_REFERENCE_COLUMNS[`${table}.${column}`] ?? DIAG_EXTERNAL_REFERENCE_COLUMNS[`${table}.*`] ?? null;
}

// ── Compteurs annoncés vs lignes détaillées (auto-contrôle) ────────────────

/**
 * Un compteur stocké annonce un nombre de lignes détaillées : l'auto-contrôle
 * compare chaque compteur au nombre de lignes réellement présentes (même
 * instantané). SQL : colonnes `id`, `annonce`, `present` (alias libres sur
 * le compte `{{A}}`).
 */
interface DiagAnnouncedCount {
  code: string;
  label: string;
  section: DiagSectionCode;
  sql: string;
  /**
   * Strict : le compteur dénombre exactement ces lignes — un compteur
   * supérieur aux lignes présentes est un MANQUE (section PARTIAL). Non
   * strict : écart signalé pour l'analyse, sans conclusion de manque.
   */
  strict: boolean;
}

export const DIAG_ANNOUNCED_COUNTS: readonly DiagAnnouncedCount[] = [
  {
    code: 'T1_FACTS_PERSISTED', strict: true, section: 'extractions-ia', label: 'Rapport T1 : faits persistés annoncés (counters.factsPersisted) vs lignes FACT du rapport',
    sql: `SELECT r.id, (r.counters->>'factsPersisted')::int AS annonce,
                 (SELECT count(*)::int FROM ai_execution_report_entries e WHERE e.account_id = r.account_id AND e.report_id = coalesce(r.entries_report_id, r.id) AND e.section = 'FACT') AS present
            FROM ai_execution_reports r WHERE r.account_id = {{A}} AND r.treatment = 'T1' AND r.counters ? 'factsPersisted' AND (r.counters->>'factsPersisted') ~ '^[0-9]+$'`,
  },
  {
    code: 'REPORT_ENTRY_COUNT', strict: true, section: 'ecritures', label: 'Rapport d’exécution : lignes annoncées (entry_count) vs lignes présentes',
    sql: `SELECT r.id, r.entry_count AS annonce,
                 (SELECT count(*)::int FROM ai_execution_report_entries e WHERE e.account_id = r.account_id AND e.report_id = coalesce(r.entries_report_id, r.id)) AS present
            FROM ai_execution_reports r WHERE r.account_id = {{A}} AND r.entry_count IS NOT NULL`,
  },
  {
    code: 'T3_REPORT_CONFLICTS', strict: false, section: 'conflits-arbitrages', label: 'Rapport T3 : conflits annoncés (counters.conflicts) vs décisions « create_conflict » du passage',
    sql: `SELECT r.id, (r.counters->>'conflicts')::int AS annonce,
                 (SELECT count(*)::int FROM reconciliation_decisions d WHERE d.account_id = r.account_id AND d.run_id = r.reconciliation_run_id AND d.action = 'create_conflict') AS present
            FROM ai_execution_reports r WHERE r.account_id = {{A}} AND r.treatment = 'T3' AND r.reconciliation_run_id IS NOT NULL AND (r.counters->>'conflicts') ~ '^[0-9]+$'`,
  },
  {
    code: 'T3_RUN_DECISIONS', strict: true, section: 'conflits-arbitrages', label: 'Passage T3 : décisions annoncées (decisions_count) vs décisions présentes',
    sql: `SELECT r.id, r.decisions_count AS annonce, (SELECT count(*)::int FROM reconciliation_decisions d WHERE d.account_id = r.account_id AND d.run_id = r.id) AS present
            FROM reconciliation_runs r WHERE r.account_id = {{A}} AND r.decisions_count IS NOT NULL`,
  },
  {
    code: 'T3_RUN_CONFLICTS', strict: false, section: 'conflits-arbitrages', label: 'Passage T3 : conflits annoncés (conflict_count) vs décisions « create_conflict »',
    sql: `SELECT r.id, r.conflict_count AS annonce, (SELECT count(*)::int FROM reconciliation_decisions d WHERE d.account_id = r.account_id AND d.run_id = r.id AND d.action = 'create_conflict') AS present
            FROM reconciliation_runs r WHERE r.account_id = {{A}} AND r.conflict_count IS NOT NULL`,
  },
  {
    code: 'T1_EXTRACTION_FACTS', strict: false, section: 'extractions-ia', label: 'Extraction T1 : faits annoncés (fact_count) vs faits présents (tous statuts)',
    sql: `SELECT x.id, x.fact_count AS annonce, (SELECT count(*)::int FROM document_facts f WHERE f.account_id = x.account_id AND f.extraction_id = x.id) AS present
            FROM document_extractions x WHERE x.account_id = {{A}} AND x.fact_count IS NOT NULL`,
  },
];

// ── Traitements IA : où retrouver entrée, sortie et décisions ─────────────

interface DiagAiOperationCoverage {
  treatment: 'T1' | 'T2' | 'T3' | 'T4' | 'T6' | 'GOUVERNANCE' | 'TRANSVERSE';
  /** Tables (couvertes) où l'entrée utile, la sortie structurée et les décisions se lisent. */
  tables: readonly string[];
}

const CALL_TRACES = ['ai_usage_event', 'ai_call_diagnostics', 'ai_call_captures', 'ai_job_queue'] as const;

/**
 * Chaque opération IA connue (`AI_OPERATIONS`) est déclarée ici : le test de
 * non-régression échoue pour une opération ajoutée sans déclaration.
 */
export const DIAG_AI_OPERATION_COVERAGE: Readonly<Record<string, DiagAiOperationCoverage>> = {
  t1_group_upload: { treatment: 'T1', tables: [...CALL_TRACES, 'document_lots', 'document_lot_items', 'document_analysis_runs'] },
  t1_analyze_document: { treatment: 'T1', tables: [...CALL_TRACES, 'document_raw_extracts', 'document_source_units', 'document_extractions', 'document_facts', 'document_tables', 'document_table_cells', 'document_unresolved_facts', 'document_extraction_coverage', 'document_operation_candidates', 'field_evidence', 'ai_execution_reports', 'ai_execution_report_entries'] },
  collect_evidence: { treatment: 'T1', tables: [...CALL_TRACES, 'field_evidence'] },
  compare_values: { treatment: 'T3', tables: [...CALL_TRACES, 'reconciliation_runs', 'reconciliation_decisions', 'inconsistency_registry', 'canonical_field_writes'] },
  t3_value_conflict: { treatment: 'T3', tables: [...CALL_TRACES, 'reconciliation_decisions', 'inconsistency_registry', 'canonical_field_writes', 'ai_execution_reports', 'ai_execution_report_entries'] },
  t3_link_ambiguity: { treatment: 'T3', tables: [...CALL_TRACES, 'document_asset_links', 'document_asset_resolutions'] },
  t3_operation_match: { treatment: 'T3', tables: [...CALL_TRACES, 'document_operation_candidates', 'business_operation_sources', 'business_operation_match_decisions', 'business_operation_identity_reviews', 'operation_semantic_reevaluations'] },
  t3_document_naming: { treatment: 'T3', tables: [...CALL_TRACES, 'document_naming_groups', 'document_naming_members', 'document_title_events', 'document_rename_events'] },
  t3_knowledge_query: { treatment: 'T3', tables: [...CALL_TRACES, 't3_knowledge_queries'] },
  retrieve_data: { treatment: 'T2', tables: [...CALL_TRACES, 'verebona_request_runs', 'verebona_ai_runs'] },
  retrieve_evidence: { treatment: 'T2', tables: [...CALL_TRACES, 'verebona_request_runs', 'verebona_ai_runs'] },
  t2_understand: { treatment: 'T2', tables: [...CALL_TRACES, 'verebona_request_runs', 'verebona_ai_runs', 'verebona_command_plans'] },
  t2_answer: { treatment: 'T2', tables: [...CALL_TRACES, 'verebona_request_runs', 'verebona_ai_runs'] },
  t2_revalidate: { treatment: 'T2', tables: [...CALL_TRACES, 'verebona_fact_revalidations'] },
  detect_dates: { treatment: 'T4', tables: [...CALL_TRACES, 'agenda_items', 'agenda_item_sources', 'field_evidence'] },
  deduplicate_event: { treatment: 'T4', tables: [...CALL_TRACES, 'agenda_items', 'agenda_intervention_consolidations', 'agenda_data_conflicts'] },
  t4_classify_event: { treatment: 'T4', tables: [...CALL_TRACES, 'agenda_items', 'agenda_item_sources', 'operation_semantic_reevaluations'] },
  t4_verify_completion: { treatment: 'T4', tables: [...CALL_TRACES, 'agenda_items', 'agenda_occurrence_events'] },
  t4_temporal_ambiguity: { treatment: 'T4', tables: [...CALL_TRACES, 'agenda_items', 'agenda_data_conflicts'] },
  evaluate_prompt: { treatment: 'GOUVERNANCE', tables: ['ai_usage_event', 'ai_prompt_versions', 'ai_master_prompt_versions'] },
  t6_formulate: { treatment: 'T6', tables: [...CALL_TRACES, 'home_mascot_generations', 'home_mascot_cache', 'home_mascot_events'] },
  t6_evaluate: { treatment: 'T6', tables: [...CALL_TRACES, 't6_evaluation_runs', 't6_interpellation_assessments', 't6_candidate_examinations'] },
};
