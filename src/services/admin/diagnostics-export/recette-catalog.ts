/**
 * Lot 82E — périmètre de l'EXPORT COMPLET DE RECETTE (décisions PO du 23/10 :
 * C-Q5, C-Q8, §4.1–4.2). PUR (aucun import serveur) : partagé par le moteur
 * d'export, la documentation des fichiers (dictionnaire) et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CLASSEMENT EXHAUSTIF DES TABLES
 *
 * Chaque table de la base est soit EXPORTÉE (domaine métier, description),
 * soit EXCLUE avec un motif explicite (journal technique, facturation,
 * configuration IA, communication…). Une table présente en base mais
 * classée nulle part (nouvelle migration) est EXPORTÉE quand même, dans le
 * domaine « non-classees », avec un avertissement dans le manifeste : jamais
 * d'omission silencieuse. Le test e2e L82E-E01 échoue tant qu'une table
 * n'est pas classée (C-Q11 : chaque évolution met à jour ce périmètre).
 *
 * Toutes les lignes de toutes les tables exportées, TOUS COMPTES confondus
 * (comptes actifs ou non : l'export n'est pas un traitement métier),
 * identifiants et colonnes de liaison conservés.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { LEGACY_CLAIM_TABLES } from '@/services/business-operations/claims/legacy-schema';

export const RECETTE_SCHEMA = 'verebona.bo.export-recette/1';

export type RecetteDomain =
  | 'comptes' | 'biens' | 'pieces' | 'equipements' | 'documents' | 'extraits-ia' | 'champs-preuves'
  | 'operations' | 'tco' | 'agenda-timeline' | 'a-traiter' | 'referentiels' | 'non-classees';

export const RECETTE_DOMAINS: Readonly<Record<RecetteDomain, { label: string; description: string }>> = {
  comptes: { label: 'Comptes et utilisateurs', description: 'Comptes, adhésions, abonnements (statuts), essais, Duo, statut de cycle de vie.' },
  biens: { label: 'Biens', description: 'Biens et leurs données propres (fiche, informations complémentaires, photos — métadonnées —, fournisseurs, budgets d’usage).' },
  pieces: { label: 'Pièces', description: 'Pièces des biens (`substructures`, seul modèle métier) et traces de l’ancien modèle `rooms` / fusion.' },
  equipements: { label: 'Équipements', description: 'Équipements, caractéristiques CIL, fournisseurs.' },
  documents: { label: 'Documents et pièces liées', description: 'Métadonnées et références des documents (jamais le fichier : clé de stockage et nom d’origine masqués), versions, rattachements aux biens / équipements / Pièces, nommage.' },
  'extraits-ia': { label: 'Extraits et résultats IA', description: 'Extracts (texte : longueur et empreinte SHA-256), faits T1, unités sources, tableaux, couverture, analyses, propositions, candidats d’Opération, rapports d’exécution, file des traitements, résultats T6.' },
  'champs-preuves': { label: 'Champs structurés, preuves et décisions', description: 'Preuves de champ, écritures canoniques, versions d’objets, réconciliations T3 et leurs décisions, contrôles d’information, registre des incohérences, corrections, campagnes / preuves / réparations du contrôle de cohérence.' },
  operations: { label: 'Opérations et rapprochements', description: 'Opérations, sources, liens biens / équipements, composantes financières, références, historique, décisions de rapprochement, revues d’identité, sinistres.' },
  tco: { label: 'TCO', description: 'Décisions utilisateur sur les lignes TCO (tables) ; lignes TCO CALCULÉES par le moteur existant (fichiers `calculs/`).' },
  'agenda-timeline': { label: 'Agenda et Timeline', description: 'Éléments d’agenda et leurs liens / sources / occurrences / consolidations / retraits, échéances historiques, événements. La Timeline d’un bien est calculée à la lecture depuis `agenda_items` et `agenda_asset_links` (statut « annule » exclu) : aucune table propre ; son résultat (vues regroupée et détaillée) est exporté en fichier calculé `calculs/timeline.part-NNNN.ndjson.gz` (lot 84C).' },
  'a-traiter': { label: 'Cartes « À traiter »', description: 'Cartes, événements, états, décisions, passages d’évaluation, campagnes de pertinence.' },
  referentiels: { label: 'Référentiels', description: 'Types de biens, de documents, catégories, types d’Opération : nécessaires pour interpréter les codes.' },
  'non-classees': { label: 'Tables non classées', description: 'Tables présentes en base mais absentes du catalogue de l’export (nouvelle migration) : exportées par prudence, à classer.' },
};

/** Tables exportées : domaine et description courte. */
export const RECETTE_TABLES: Readonly<Record<string, { domain: Exclude<RecetteDomain, 'non-classees'>; description: string }>> = {
  // ── Comptes ────────────────────────────────────────────────────────────
  accounts: { domain: 'comptes', description: 'Comptes (statut, offre, cycle de vie).' },
  users: { domain: 'comptes', description: 'Utilisateurs (identité pseudonymisée : e-mail, nom, téléphone masqués ; secrets jamais exportés).' },
  account_memberships: { domain: 'comptes', description: 'Adhésions utilisateur ↔ compte (rôle, statut).' },
  account_subscriptions: { domain: 'comptes', description: 'Abonnement du compte (statut, offre, échéances).' },
  subscription_history: { domain: 'comptes', description: 'Historique des changements d’abonnement.' },
  trial_grants: { domain: 'comptes', description: 'Essais accordés (sept jours).' },
  duo_accounts: { domain: 'comptes', description: 'Premium Duo : comptes Duo.' },
  duo_memberships: { domain: 'comptes', description: 'Premium Duo : membres.' },
  duo_shared_account_journal: { domain: 'comptes', description: 'Premium Duo : journal du compte partagé (lot 72D).' },
  account_analysis_counters: { domain: 'comptes', description: 'Compteurs d’analyses du compte.' },
  account_analysis_credits: { domain: 'comptes', description: 'Crédits d’analyses du compte.' },
  account_audit_log: { domain: 'comptes', description: 'Journal des événements du compte.' },
  scheduled_account_deletions: { domain: 'comptes', description: 'Suppressions de compte programmées.' },
  account_processing_states: { domain: 'comptes', description: 'Éligibilité au traitement (actif / lecture seule / suspendu), transitions, neutralisations et rattrapages à la réactivation (lot 82A).' },
  // ── Biens ──────────────────────────────────────────────────────────────
  assets: { domain: 'biens', description: 'Biens (fiche, caractéristiques clés, statut, cycle de vie).' },
  asset_additional_infos: { domain: 'biens', description: 'Informations complémentaires des biens.' },
  asset_cil_profiles: { domain: 'biens', description: 'Profils CIL des biens.' },
  asset_custom_fields: { domain: 'biens', description: 'Champs personnalisés (définitions).' },
  asset_custom_field_values: { domain: 'biens', description: 'Champs personnalisés (valeurs).' },
  asset_photos: { domain: 'biens', description: 'Photos des biens (métadonnées et références ; jamais le fichier).' },
  asset_suppliers: { domain: 'biens', description: 'Fournisseurs rattachés aux biens.' },
  asset_transmissions: { domain: 'biens', description: 'Transmissions de biens.' },
  asset_usage_budgets: { domain: 'biens', description: 'Budgets d’usage des biens (TCO prévisionnel).' },
  asset_space_moves: { domain: 'biens', description: 'Déplacements entre espaces.' },
  asset_move_requests: { domain: 'biens', description: 'Demandes de déplacement de bien entre comptes.' },
  asset_delete_requests: { domain: 'biens', description: 'Demandes de suppression de bien.' },
  cil_block_resolutions: { domain: 'biens', description: 'Résolutions de blocs CIL.' },
  energy_materials: { domain: 'biens', description: 'Matériaux (énergie).' },
  energy_works: { domain: 'biens', description: 'Travaux (énergie).' },
  suppliers: { domain: 'biens', description: 'Fournisseurs du compte.' },
  supplier_review_items: { domain: 'biens', description: 'Fournisseurs à revoir.' },
  supplier_contact_observations: { domain: 'biens', description: 'Observations de coordonnées fournisseur.' },
  // ── Pièces ─────────────────────────────────────────────────────────────
  substructures: { domain: 'pieces', description: 'Pièces des biens (terme métier « Pièce » ; nom technique historique).' },
  rooms: { domain: 'pieces', description: 'Ancien modèle des pièces (avant fusion dans `substructures`).' },
  room_merge_runs: { domain: 'pieces', description: 'Exécutions de la fusion pièces → Pièces.' },
  room_merge_changes: { domain: 'pieces', description: 'Changements journalisés de la fusion (restauration).' },
  // ── Équipements ────────────────────────────────────────────────────────
  equipments: { domain: 'equipements', description: 'Équipements des biens.' },
  equipment_cil_specs: { domain: 'equipements', description: 'Caractéristiques CIL (marque, modèle, n° de série).' },
  equipment_suppliers: { domain: 'equipements', description: 'Fournisseurs des équipements.' },
  // ── Documents ──────────────────────────────────────────────────────────
  asset_files: { domain: 'documents', description: 'Documents (métadonnées, classement, rattachements colonnes, état d’analyse) — clé de stockage et nom d’origine masqués.' },
  documents: { domain: 'documents', description: 'Ancienne table des documents (héritage).' },
  document_versions: { domain: 'documents', description: 'Versions des documents (métadonnées).' },
  asset_file_thumbnails: { domain: 'documents', description: 'Miniatures (métadonnées).' },
  document_asset_links: { domain: 'documents', description: 'Rattachements N-N document ↔ bien / équipement / Pièce (rôle, statut, origine).' },
  document_asset_resolutions: { domain: 'documents', description: 'Résolutions du rattachement document ↔ bien.' },
  document_asset_identifier_changes: { domain: 'documents', description: 'Changements d’identifiant de rattachement.' },
  document_cil_metadata: { domain: 'documents', description: 'Métadonnées CIL des documents.' },
  document_lots: { domain: 'documents', description: 'Lots de dépôt.' },
  document_lot_items: { domain: 'documents', description: 'Éléments des lots de dépôt.' },
  document_naming_groups: { domain: 'documents', description: 'Groupes de nommage (T3).' },
  document_naming_members: { domain: 'documents', description: 'Membres des groupes de nommage.' },
  document_rename_events: { domain: 'documents', description: 'Renommages de documents.' },
  document_title_events: { domain: 'documents', description: 'Titres retenus et leurs changements.' },
  document_classification_feedback: { domain: 'documents', description: 'Retours de classement.' },
  document_validation_reprise: { domain: 'documents', description: 'Reprise des documents « à valider » (lot 71B).' },
  document_suppliers: { domain: 'documents', description: 'Fournisseurs cités par les documents.' },
  event_documents: { domain: 'documents', description: 'Pièces jointes des événements.' },
  // ── Extraits et résultats IA ──────────────────────────────────────────
  document_raw_extracts: { domain: 'extraits-ia', description: 'Extracts bruts (texte : longueur et SHA-256, ou intégral sur habilitation).' },
  document_extractions: { domain: 'extraits-ia', description: 'Extractions T1 (modèle, version de prompt, montant, date, fournisseur).' },
  document_extraction_coverage: { domain: 'extraits-ia', description: 'Couverture de l’extraction T1.' },
  document_facts: { domain: 'extraits-ia', description: 'Faits T1.' },
  document_source_units: { domain: 'extraits-ia', description: 'Unités sources (pages, blocs) des extractions.' },
  document_tables: { domain: 'extraits-ia', description: 'Tableaux extraits.' },
  document_table_cells: { domain: 'extraits-ia', description: 'Cellules des tableaux extraits.' },
  document_unresolved_facts: { domain: 'extraits-ia', description: 'Faits T1 non résolus.' },
  document_value_decisions: { domain: 'extraits-ia', description: 'Décisions T1 sur les valeurs significatives des unités sources (structurée, composante ou contexte, non retenue avec motif, indéterminée ; provenance, rattachements, validité, historique) — lot 91D.' },
  document_analysis_runs: { domain: 'extraits-ia', description: 'Analyses de documents (exécutions).' },
  document_analysis_proposals: { domain: 'extraits-ia', description: 'Propositions issues des analyses.' },
  document_field_values: { domain: 'extraits-ia', description: 'Valeurs de champs documentaires.' },
  document_rule_evaluations: { domain: 'extraits-ia', description: 'Évaluations de règles documentaires.' },
  // Lot 85F (0720) : mémoire des interprétations sémantiques T3 de la connaissance T1 (KNOWLEDGE_QUERY).
  t3_knowledge_queries: { domain: 'extraits-ia', description: 'Interprétations T3 de la connaissance T1 persistée (question, empreinte du contexte, issue validée, constats et preuves citées, refus, appels IA) — lot 85F.' },
  document_operation_candidates: { domain: 'extraits-ia', description: 'Candidats d’Opération T1 et décision T3.' },
  t1_quality_signals: { domain: 'extraits-ia', description: 'Signaux de qualité T1.' },
  ai_execution_reports: { domain: 'extraits-ia', description: 'Rapports d’exécution T1 / T3 (synthèse).' },
  ai_execution_report_entries: { domain: 'extraits-ia', description: 'Lignes des rapports d’exécution (écritures confirmées).' },
  ai_job_queue: { domain: 'extraits-ia', description: 'File des traitements IA (statut, tentatives, résultat métier).' },
  ai_t3_enqueue_events: { domain: 'extraits-ia', description: 'Mises en file T3.' },
  ai_field_updates: { domain: 'extraits-ia', description: 'Mises à jour de champs par l’IA.' },
  ai_output_replays: { domain: 'extraits-ia', description: 'Résolutions rejouées de sorties IA.' },
  t6_evaluation_runs: { domain: 'extraits-ia', description: 'Évaluations T6 par échéance.' },
  t6_interpellation_assessments: { domain: 'extraits-ia', description: 'Interpellations T6.' },
  t6_candidate_examinations: { domain: 'extraits-ia', description: 'Examens de candidats T6.' },
  t6_reminder_preferences: { domain: 'extraits-ia', description: 'Préférences de rappel T6.' },
  home_mascot_generations: { domain: 'extraits-ia', description: 'Générations de l’accueil (T6).' },
  home_mascot_events: { domain: 'extraits-ia', description: 'Événements de l’accueil (T6).' },
  home_mascot_acknowledgments: { domain: 'extraits-ia', description: 'Acquittements de l’accueil (T6).' },
  home_mascot_cache: { domain: 'extraits-ia', description: 'Cache de l’accueil (T6).' },
  home_mascot_pregen_requests: { domain: 'extraits-ia', description: 'Demandes de pré-génération de l’accueil.' },
  // ── Champs structurés, preuves, décisions ─────────────────────────────
  property_recovery_runs: { domain: 'champs-preuves', description: 'Analyses T3 des propriétés manquantes (contexte : empreinte, résumé borné, troncature ; issue, appels IA) — lot 88B.' },
  property_recovery_decisions: { domain: 'champs-preuves', description: 'Décisions par propriété manquante (écrite / abstention et cause, avant / après, preuves, provenance, traitement) — lot 88B.' },
  field_evidence: { domain: 'champs-preuves', description: 'Preuves des champs (source, cible, statut de cycle de vie).' },
  canonical_field_writes: { domain: 'champs-preuves', description: 'Écritures canoniques des champs (origine, avant / après).' },
  object_versions: { domain: 'champs-preuves', description: 'Versions des objets (empreinte de contenu, dernière vérification).' },
  field_origin_migration_audit: { domain: 'champs-preuves', description: 'Audit de migration des origines de champs.' },
  reconciliation_runs: { domain: 'champs-preuves', description: 'Passages de réconciliation T3.' },
  reconciliation_decisions: { domain: 'champs-preuves', description: 'Décisions de réconciliation T3 (action, motif, confiance, preuves).' },
  account_reconciliation_runs: { domain: 'champs-preuves', description: 'Réconciliations par compte.' },
  t3_information_checks: { domain: 'champs-preuves', description: 'Contrôles « Informations » (lot 76J).' },
  t3_reconciliation_states: { domain: 'champs-preuves', description: 'États de réconciliation T3.' },
  t3_open_action_evaluations: { domain: 'champs-preuves', description: 'Évaluations T3 des actions ouvertes.' },
  account_knowledge_changes: { domain: 'champs-preuves', description: 'Changements de connaissance du compte (déclencheurs de contrôle).' },
  inconsistency_registry: { domain: 'champs-preuves', description: 'Registre des incohérences (valeur actuelle / proposée, résolution).' },
  coherence_campaigns: { domain: 'champs-preuves', description: 'Campagnes de contrôle de cohérence (quotidienne, rattrapage, manuelle), mode, périmètre, métriques (lot 82B).' },
  coherence_object_proofs: { domain: 'champs-preuves', description: 'Preuve technique de contrôle par objet et par contrôle (C-Q4).' },
  coherence_repairs: { domain: 'champs-preuves', description: 'Constats et réparations de cohérence (avant / après, service utilisé, statut).' },
  impact_queue: { domain: 'champs-preuves', description: 'File des impacts (recalculs déclenchés).' },
  data_separation_corrections: { domain: 'champs-preuves', description: 'Corrections bien / équipement (lot 71A).' },
  cross_account_remediations: { domain: 'champs-preuves', description: 'Corrections d’isolation des comptes (lot 53).' },
  cdc15_migration_runs: { domain: 'champs-preuves', description: 'Rattrapage CDC 15 : exécutions.' },
  cdc15_migration_report: { domain: 'champs-preuves', description: 'Rattrapage CDC 15 : rapport.' },
  cdc15_migration_backups: { domain: 'champs-preuves', description: 'Rattrapage CDC 15 : valeurs sauvegardées (restauration).' },
  // ── Opérations ─────────────────────────────────────────────────────────
  business_operations: { domain: 'operations', description: 'Opérations (type, statut, dates, prestataire, fusion, invalidation).' },
  business_operation_sources: { domain: 'operations', description: 'Sources des Opérations (documents…), méthode et motif de rapprochement.' },
  business_operation_asset_links: { domain: 'operations', description: 'Liens Opération ↔ bien.' },
  business_operation_equipment_links: { domain: 'operations', description: 'Liens Opération ↔ équipement.' },
  business_operation_asset_exclusions: { domain: 'operations', description: 'Exclusions Opération ↔ bien.' },
  business_operation_asset_data_marks: { domain: 'operations', description: 'Marques des données structurées des biens.' },
  business_operation_financial_components: { domain: 'operations', description: 'Composantes financières (montants, périodes, cibles).' },
  business_operation_financial_component_sources: { domain: 'operations', description: 'Sources des composantes financières.' },
  business_operation_side_amounts: { domain: 'operations', description: 'Montants annexes.' },
  business_operation_references: { domain: 'operations', description: 'Références (n° de contrat, de facture…).' },
  business_operation_history: { domain: 'operations', description: 'Historique des Opérations.' },
  business_operation_match_decisions: { domain: 'operations', description: 'Décisions de rapprochement.' },
  business_operation_identity_reviews: { domain: 'operations', description: 'Revues d’identité économique (séparations, doublons).' },
  business_operation_projection_suppressions: { domain: 'operations', description: 'Suppressions de projection vers l’agenda.' },
  business_operation_contract_details: { domain: 'operations', description: 'Détails de contrat.' },
  business_operation_financing_details: { domain: 'operations', description: 'Détails de financement.' },
  // Lot 83D (V-Q1, V-Q2, V-Q8) : plus de bloc « Sinistres » sur les biens — le sinistre est l'Opération CLAIM
  // consolidée (documents, agenda, Pièces, équipements) ; détails et dommages conservés pour le dossier d'assurance.
  business_operation_claim_details: { domain: 'operations', description: 'Sinistres (Opération CLAIM) : données d’assurance utiles et sourcées (type, déclaration, référence assureur, police, avancement, circonstances, conséquences, estimation).' },
  business_operation_claim_damages: { domain: 'operations', description: 'Sinistres (Opération CLAIM) : dommages détaillés conservés pour le dossier d’assurance (aucun écran de saisie).' },
  business_operation_claim_damage_documents: { domain: 'operations', description: 'Sinistres : justificatifs des dommages (documents reliés, jamais copiés).' },
  business_operation_claim_damage_photos: { domain: 'operations', description: 'Sinistres : photos des dommages (références vers les photos du bien, jamais copiées).' },
  business_operation_claim_actions: { domain: 'operations', description: 'Sinistres : actions de l’ancien modèle — INERTES depuis le lot 83D (plus lues ni écrites), vidées par le rattrapage « Sinistres : nettoyage de l’ancien modèle », table SUPPRIMÉE par sa finalisation (lot 84A) : absente de l’export ensuite.' },
  business_operation_claim_exchanges: { domain: 'operations', description: 'Sinistres : échanges de l’ancien modèle — INERTES depuis le lot 83D, vidés par le rattrapage de nettoyage, table SUPPRIMÉE par sa finalisation (lot 84A).' },
  business_operation_claim_migration_marks: { domain: 'operations', description: 'Sinistres : repères de migration de l’ancien formulaire (lot 44) — INERTES depuis le lot 83D, vidés par le rattrapage de nettoyage, table SUPPRIMÉE par sa finalisation (lot 84A).' },
  claim_legacy_cleanup_runs: { domain: 'operations', description: 'Sinistres : exécutions du rattrapage de nettoyage de l’ancien modèle (lot 83D : simulation, application, restauration, refus sans point de restauration).' },
  claim_legacy_cleanup_journal: { domain: 'operations', description: 'Sinistres : journal du nettoyage de l’ancien modèle (image avant de chaque ligne purgée, restaurable par exécution — lot 83D).' },
  business_operation_room_links: { domain: 'operations', description: 'Liens Opération ↔ Pièce (lot 82D).' },
  business_operation_documents: { domain: 'operations', description: 'Documents d’une Opération avec leur rôle (lot 82D).' },
  // Lot 84E (CDC v5 O-6, §27.6) : journal des reconsolidations ciblées.
  business_operation_targeted_runs: { domain: 'operations', description: 'Reconsolidations ciblées (équipement, bien, Pièce, série de documents récurrents, liens directs Document ↔ Équipement) : déclencheur, cible, compteurs, appels IA, issue (lot 84E).' },
  // Lot 87B (ticket « orchestration T3/T4 ») : journal des réévaluations sémantiques T3 / T4.
  operation_semantic_reevaluations: { domain: 'operations', description: 'Réévaluations sémantiques T3 (identité d’Opération) / T4 (représentation Agenda) : déclencheur (contrôle, projection après T3, reprise, geste), contexte (résumé, empreinte), décision IA reçue, validation, rôles décidés, mutations appliquées / refusées, état avant / après, appels IA (lot 87B).' },
  // Lot 85A (CDC v5 O-2, §20) : journal du rattrapage « Opérations v5 : purge et reconstruction ».
  operations_rebuild_runs: { domain: 'operations', description: 'Opérations v5 : exécutions de la purge et reconstruction en préproduction (simulation, application, restauration, refus sans point de restauration ; lot 85A).' },
  operations_rebuild_accounts: { domain: 'operations', description: 'Opérations v5 : rapport par compte de la reconstruction (statut, empreintes avant / après, inventaire purgé / conservé et motifs, TCO relu, coût IA ; lot 85A).' },
  operations_rebuild_snapshots: { domain: 'operations', description: 'Opérations v5 : image avant des lignes d’un compte (tables du périmètre de la reconstruction), restauration exacte par exécution (lot 85A).' },
  // ── TCO ────────────────────────────────────────────────────────────────
  asset_cost_line_decisions: { domain: 'tco', description: 'Décisions utilisateur sur les lignes TCO.' },
  asset_cost_line_decision_events: { domain: 'tco', description: 'Historique des décisions sur les lignes TCO.' },
  // ── Agenda et Timeline ─────────────────────────────────────────────────
  agenda_items: { domain: 'agenda-timeline', description: 'Éléments d’agenda (source de la Timeline).' },
  agenda_asset_links: { domain: 'agenda-timeline', description: 'Liens agenda ↔ bien (Timeline du bien).' },
  agenda_equipment_links: { domain: 'agenda-timeline', description: 'Liens agenda ↔ équipement.' },
  agenda_file_links: { domain: 'agenda-timeline', description: 'Liens agenda ↔ document.' },
  agenda_room_links: { domain: 'agenda-timeline', description: 'Liens agenda ↔ Pièce.' },
  agenda_item_sources: { domain: 'agenda-timeline', description: 'Sources des éléments d’agenda.' },
  agenda_occurrence_events: { domain: 'agenda-timeline', description: 'Occurrences (récurrences).' },
  agenda_item_removals: { domain: 'agenda-timeline', description: 'Retraits d’éléments d’agenda (traçables, restaurables).' },
  agenda_intervention_consolidations: { domain: 'agenda-timeline', description: 'Consolidations d’interventions (lot 76H).' },
  agenda_data_conflicts: { domain: 'agenda-timeline', description: 'Conflits de données d’agenda.' },
  deadlines: { domain: 'agenda-timeline', description: 'Échéances historiques.' },
  events: { domain: 'agenda-timeline', description: 'Événements historiques.' },
  calendar_additions: { domain: 'agenda-timeline', description: 'Ajouts au calendrier personnel.' },
  annual_renewal_reminder_state: { domain: 'agenda-timeline', description: 'Rappels de renouvellement annuel (état).' },
  annual_renewal_reminder_checks: { domain: 'agenda-timeline', description: 'Rappels de renouvellement annuel (contrôles).' },
  // ── « À traiter » ──────────────────────────────────────────────────────
  to_process_actions: { domain: 'a-traiter', description: 'Cartes « À traiter » (règle, cible, statut, résolution).' },
  to_process_action_events: { domain: 'a-traiter', description: 'Événements des cartes.' },
  to_process_item_state: { domain: 'a-traiter', description: 'États des éléments.' },
  to_process_decisions: { domain: 'a-traiter', description: 'Décisions de l’utilisateur.' },
  to_process_evaluation_passages: { domain: 'a-traiter', description: 'Passages d’évaluation.' },
  to_process_trace_retries: { domain: 'a-traiter', description: 'Reprises de traces.' },
  to_process_digest_state: { domain: 'a-traiter', description: 'État des récapitulatifs.' },
  to_process_digest_runs: { domain: 'a-traiter', description: 'Récapitulatifs (exécutions).' },
  to_process_relevance_campaigns: { domain: 'a-traiter', description: 'Campagnes de pertinence.' },
  to_process_relevance_campaign_items: { domain: 'a-traiter', description: 'Éléments des campagnes de pertinence.' },
  to_process_relevance_recette_runs: { domain: 'a-traiter', description: 'Recettes de pertinence.' },
  to_process_arbitration_reprises: { domain: 'a-traiter', description: 'Reprises des faux arbitrages (lot 81A).' },
  to_process_scan_runs: { domain: 'a-traiter', description: 'Balayages « À traiter ».' },
  to_process_config_baselines: { domain: 'a-traiter', description: 'Références de configuration « À traiter ».' },
  // ── Référentiels ───────────────────────────────────────────────────────
  asset_types: { domain: 'referentiels', description: 'Types de biens.' },
  asset_type_subcategories: { domain: 'referentiels', description: 'Sous-catégories de biens.' },
  document_types: { domain: 'referentiels', description: 'Types de documents.' },
  document_categories: { domain: 'referentiels', description: 'Catégories de documents.' },
  document_category_asset_associations: { domain: 'referentiels', description: 'Catégories de documents ↔ biens.' },
  document_category_type_associations: { domain: 'referentiels', description: 'Catégories ↔ types de documents.' },
  document_type_asset_associations: { domain: 'referentiels', description: 'Types de documents ↔ biens.' },
  document_type_export_associations: { domain: 'referentiels', description: 'Types de documents ↔ exports.' },
  document_taxonomy_mappings: { domain: 'referentiels', description: 'Correspondances de taxonomie.' },
  document_reference_corrections: { domain: 'referentiels', description: 'Corrections du référentiel documentaire.' },
  business_operation_types: { domain: 'referentiels', description: 'Types d’Opération.' },
  field_dependencies: { domain: 'referentiels', description: 'Dépendances entre champs.' },
};

/** Tables NON exportées, avec leur motif (lu dans le manifeste). */
export const RECETTE_EXCLUDED: Readonly<Record<string, string>> = {
  _migrations: 'technique : suivi des migrations',
  job_locks: 'technique : baux des tâches',
  auth_rate_limits: 'sécurité : limitation des connexions',
  revoked_tokens: 'sécurité : jetons révoqués',
  user_session_revocations: 'sécurité : révocations de sessions',
  user_sessions: 'sécurité : registre des sessions (empreintes de jetons et d’appareils)',
  reauth_proofs: 'sécurité : preuves de réauthentification',
  email_change_requests: 'sécurité : demandes de changement d’adresse (empreintes de liens)',
  auth_transactions: 'sécurité : transactions OAuth Google / Apple',
  auth_identities: 'sécurité : méthodes de connexion Google / Apple (identifiant chez le fournisseur, jeton chiffré)',
  idempotency_keys: 'technique : idempotence des requêtes',
  admin_audit_log: 'journal d’administration (BO › Journal)',
  admin_anomalies: 'supervision BO (export diagnostic 77C)',
  admin_anomaly_occurrences: 'supervision BO (export diagnostic 77C)',
  admin_export_generations: 'suivi des exports BO (dont celui-ci)',
  ops_backfill_runs: 'suivi des rattrapages BO',
  scheduled_task_state: 'état des tâches planifiées',
  account_isolation_checks: 'contrôle de sécurité (BO › Isolation des comptes)',
  migration_0250_unpaid_backup: 'sauvegarde technique d’une migration',
  // Journaux et configuration IA (export diagnostic 77C, Pilotage IA).
  ai_usage_event: 'journal des appels IA (diagnostic 77C)',
  ai_usage_events: 'ancien journal des appels IA',
  ai_usage_daily_rollup: 'agrégats de coûts IA',
  ai_usage_account_counter: 'compteurs d’usage IA',
  ai_call_diagnostics: 'sorties modèle (accès restreint, diagnostic 77C)',
  ai_call_captures: 'capture des échanges IA (Pilotage IA P1, accès restreint, contenu potentiellement personnel)',
  ai_call_capture_state: 'configuration de la capture IA (Pilotage IA P1)',
  ai_operation: 'journal des opérations IA (diagnostic 77C)',
  ai_operations: 'ancien journal des opérations IA',
  ai_operation_idempotency: 'technique IA',
  ai_pipeline_step: 'journal des étapes IA',
  ai_pipeline_version: 'configuration IA',
  ai_analysis_version: 'configuration IA',
  ai_search_log: 'journal de recherche IA',
  ai_security_lock: 'sécurité IA',
  ai_account_cost_caps: 'plafonds de coûts IA',
  ai_alerts: 'alertes IA (supervision)',
  ai_admin_audit_log: 'journal d’administration IA',
  ai_config_entries: 'configuration IA', ai_config_exports: 'configuration IA', ai_config_packages: 'configuration IA',
  ai_config_revisions: 'configuration IA', ai_config_versions: 'configuration IA', ai_cost_anomaly_settings: 'configuration IA',
  ai_cost_settings: 'configuration IA', ai_emergency_stop: 'configuration IA', ai_evaluator_runs: 'qualification IA',
  ai_instructions: 'configuration IA (prompts)', ai_legacy_usage_mapping: 'technique IA', ai_log_archives: 'archives des journaux IA',
  ai_master_corpus_runs: 'qualification IA', ai_master_prompt_activations: 'configuration IA (prompts)', ai_master_prompt_test_runs: 'qualification IA',
  ai_master_prompt_versions: 'configuration IA (prompts)', ai_model_catalog: 'catalogue des modèles', ai_model_catalog_refresh: 'catalogue des modèles',
  ai_model_operational_status: 'catalogue des modèles', ai_model_price_changes: 'tarifs des modèles', ai_model_price_status: 'tarifs des modèles',
  ai_model_pricing: 'tarifs des modèles', ai_model_pricing_refresh_log: 'tarifs des modèles', ai_model_qualification: 'qualification IA',
  // Lot 85C (Pilotage IA V2 P4) : journal des changements de capacités des modèles.
  ai_model_capability_changes: 'configuration IA (journal des capacités des modèles)',
  // Lot 86A (Pilotage IA V2 P5) : qualification par couple — journaux techniques (empreintes, jamais de contenu).
  ai_qualification_campaigns: 'qualification IA (campagnes par couple, point de restauration)',
  ai_qualification_campaign_accounts: 'qualification IA (verrous de compte des campagnes)',
  ai_qualification_evidence: 'qualification IA (preuves historisées par couple)',
  ai_qualification_cases: 'qualification IA (résultats par cas, empreintes)',
  // Ancien harnais de mesure (cron `corpus-run`, retiré au lot 86A : absorbé par la qualification par couple) — table inerte, créée à la volée en préproduction.
  ai_corpus_baseline: 'qualification IA (ancien harnais de mesure retiré au lot 86A, table inerte)',
  // Lot 86B (Pilotage IA V2 P6) : imports de la configuration globale, interventions manuelles, routage subordonné.
  ai_config_imports: 'configuration IA (journal des imports et retours arrière)',
  ai_config_interventions: 'configuration IA (exclusions et gels manuels)',
  ai_routing_promotions: 'configuration IA (état de routage subordonné)',
  ai_prompt_change_requests: 'configuration IA (prompts)', ai_prompt_test_runs: 'qualification IA', ai_prompt_versions: 'configuration IA (prompts)',
  ai_provider_credential: 'secret fournisseur IA', ai_queue_worker_heartbeats: 'technique (battements des workers)',
  ai_retired_treatment_archive: 'archives IA retirées', ai_t2_content_access_log: 'journal d’accès sensible (T2)', ai_treatment_state: 'configuration IA',
  ai_use_cases: 'configuration IA', analysis_packs: 'catalogue commercial',
  // Assistant T2 (conversations : contenu personnel).
  verebona_ai_runs: 'assistant T2 (journal)', verebona_assistant_setting_requests: 'assistant T2 (réglages)', verebona_assistant_settings: 'assistant T2 (réglages)',
  verebona_cache_versions: 'assistant T2 (technique)', verebona_claim_sources: 'assistant T2', verebona_clarification_events: 'assistant T2',
  verebona_command_events: 'assistant T2', verebona_command_plans: 'assistant T2', verebona_command_undo_steps: 'assistant T2',
  verebona_conversations: 'assistant T2 (conversations)', verebona_fact_revalidations: 'assistant T2', verebona_feedback: 'assistant T2',
  verebona_help_entries: 'assistant T2 (aide)', verebona_message_actions: 'assistant T2', verebona_message_claims: 'assistant T2',
  verebona_message_sources: 'assistant T2', verebona_messages: 'assistant T2 (messages)', verebona_presented_entities: 'assistant T2',
  verebona_rate_limit_counters: 'assistant T2 (technique)', verebona_request_runs: 'assistant T2', verebona_usage_events: 'assistant T2 (journal)',
  help_article_feedback: 'aide en ligne',
  // Facturation, Stripe, commercial.
  billing_price_operations: 'facturation', invoices: 'facturation', dunning_events: 'facturation', plan_configs: 'catalogue commercial',
  plan_limits: 'catalogue commercial', promo_codes: 'catalogue commercial', subscription_plans: 'catalogue commercial',
  stripe_catalog_products: 'Stripe', stripe_catalog_recoveries: 'Stripe', stripe_catalog_runs: 'Stripe', stripe_catalog_state: 'Stripe',
  stripe_invoice_effects: 'Stripe', stripe_price_migrations: 'Stripe', stripe_price_versions: 'Stripe', stripe_webhook_logs: 'Stripe',
  subscription_communication_operations: 'communications d’abonnement',
  referral_email_sends: 'parrainage', referral_events: 'parrainage', referral_links: 'parrainage',
  funnel_events: 'statistiques de conversion', signup_contexts: 'statistiques d’inscription', user_activity_log: 'journal d’activité',
  user_guide_progress: 'progression du guide', news_consents: 'consentements de communication',
  // Communications.
  email_logs: 'journal des e-mails', email_provider_events: 'journal du fournisseur d’e-mails', email_settings: 'configuration e-mail',
  email_template_versions: 'modèles d’e-mails', email_templates: 'modèles d’e-mails', communication_channel_settings: 'configuration des canaux',
  transactional_email_jobs: 'file des e-mails transactionnels', notification_outbox: 'file des notifications',
  notification_deliveries: 'livraisons de notifications', notification_events: 'journal des notifications', notification_preferences: 'préférences de notification',
  notifications: 'notifications (cloche)', push_subscriptions: 'anciens abonnements Web Push (table dormante)',
  mobile_push_installations: 'appareils de l’application mobile (jetons push)',
  // Juridique, RGPD, rétractation.
  legal_acceptances: 'juridique', legal_audit_log: 'juridique', legal_document_versions: 'juridique',
  gdpr_exports: 'RGPD', gdpr_requests: 'RGPD',
  withdrawal_events: 'rétractation', withdrawal_requests: 'rétractation', withdrawal_verification_tokens: 'rétractation (jetons)',
  // Exports V12 et fichiers techniques.
  export_generation: 'dossiers V12 générés (fichiers expirant à 30 jours)', export_generation_items: 'dossiers V12', export_generation_logs: 'dossiers V12',
  export_templates: 'modèles d’export V12', export_dossier_availability: 'disponibilité des dossiers V12',
  pending_blob_deletions: 'file de suppression des fichiers du stockage', system_files: 'fichiers système', system_logos: 'logos système',
  agenda_intervention_reprise_runs: 'technique : reprise des doublons d’agenda (exécutions)',
  t6_evaluation_signature_baselines: 'technique T6 (références de signature)',
};

interface TableClassification {
  /** Exportées (catalogue), triées par domaine puis nom. */
  included: Array<{ table: string; domain: RecetteDomain; description: string }>;
  excluded: Array<{ table: string; motif: string }>;
  /** Présentes en base, absentes du catalogue : EXPORTÉES quand même (domaine « non-classees »). */
  unclassified: string[];
  /** Au catalogue mais absentes de la base (table retirée). */
  missing: string[];
}

const DOMAIN_ORDER = Object.keys(RECETTE_DOMAINS) as RecetteDomain[];

/**
 * Lot 84A (O-10) : tables du catalogue qui PEUVENT être absentes de la base —
 * ancien modèle Sinistres supprimé par la finalisation du nettoyage BO.
 * Exportées tant qu'elles existent ; leur absence n'est pas un écart.
 */
export const RECETTE_RETIRABLE_TABLES: ReadonlySet<string> = new Set([
  ...LEGACY_CLAIM_TABLES,
  // Lot 86A : table de l'ancien harnais de mesure, créée à la volée par la route retirée (jamais par une migration).
  'ai_corpus_baseline',
]);

/** Classement des tables présentes en base. */
export function classifyTables(dbTables: readonly string[]): TableClassification {
  const present = new Set(dbTables);
  const out: TableClassification = { included: [], excluded: [], unclassified: [], missing: [] };
  for (const t of [...dbTables].sort()) {
    const c = RECETTE_TABLES[t];
    if (c) out.included.push({ table: t, domain: c.domain, description: c.description });
    else if (t in RECETTE_EXCLUDED) out.excluded.push({ table: t, motif: RECETTE_EXCLUDED[t] });
    else {
      out.unclassified.push(t);
      out.included.push({ table: t, domain: 'non-classees', description: RECETTE_DOMAINS['non-classees'].description });
    }
  }
  out.included.sort((a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain) || a.table.localeCompare(b.table));
  out.missing = [...Object.keys(RECETTE_TABLES), ...Object.keys(RECETTE_EXCLUDED)].filter((t) => !present.has(t) && !RECETTE_RETIRABLE_TABLES.has(t)).sort();
  return out;
}

/** Lignes par partie de fichier (découpage : chaque partie est un fichier ; totaux contrôlables). */
export const RECETTE_PART_ROWS = 100_000;
/** Conservation des exports de recette dans le stockage (comme les sauvegardes). */
export const RECETTE_RETENTION_DAYS = 30;
/** Préfixe de stockage (OVH S3). */
export const RECETTE_PREFIX = 'admin-exports/recette/';

/** Chemin d'une partie de données : `donnees/<domaine>/<table>.part-0001.ndjson.gz`. */
export function recetteDataPath(domain: RecetteDomain, table: string, part: number): string {
  return `donnees/${domain}/${table}.part-${String(part).padStart(4, '0')}.ndjson.gz`;
}

/** Chemin relatif sûr (téléchargement) : segments [a-z0-9._-], pas de remontée. */
export function isSafeRecettePath(p: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i.test(p) && !p.includes('..') && p.length <= 300;
}
