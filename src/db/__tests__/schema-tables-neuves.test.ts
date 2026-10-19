/**
 * Relecture lot 17 — tables NEUVES des lots 14 à 17 déclarées dans Drizzle
 * (protection contre `db:push`) : alignement EXACT avec le SQL de leur
 * migration (colonnes, NOT NULL, contraintes CHECK, index).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { agendaItemRemovals, aiMasterCorpusRuns, documentFieldValues, cdc15MigrationBackups, cdc15MigrationReport, cdc15MigrationRuns, roomMergeChanges, roomMergeRuns, documentSourceUnits, documentExtractionCoverage, documentUnresolvedFacts,
  businessOperationTypes, businessOperations, businessOperationSources, businessOperationAssetLinks, businessOperationEquipmentLinks,
  businessOperationFinancialComponents, businessOperationFinancialComponentSources, businessOperationHistory,
  businessOperationProjectionSuppressions, businessOperationReferences, documentOperationCandidates, businessOperationMatchDecisions,
  businessOperationContractDetails, businessOperationFinancingDetails, businessOperationClaimDetails, businessOperationClaimDamages,
  businessOperationClaimDamageDocuments, businessOperationClaimDamagePhotos, businessOperationClaimActions, businessOperationClaimExchanges,
  businessOperationAssetDataMarks, businessOperationClaimMigrationMarks, stripeCatalogRecoveries,
  transactionalEmailJobs, emailProviderEvents, documentRawExtracts,
  annualRenewalReminderState, annualRenewalReminderChecks,
} from '../schema';

const MIG = join(process.cwd(), 'src/db/migrations');

/** Colonnes (nom → NOT NULL) d'un CREATE TABLE, et noms des contraintes / index du fichier. */
function sqlTable(file: string, table: string) {
  // Lot 34F : les index CONCURRENTLY des fichiers `_idx_N` de la migration comptent aussi.
  // Lot 40 : migrations ULTÉRIEURES de la même table (colonnes, index remplacés).
  const fichiers = [file, ...(SUITES[table] ?? [])];
  const idx = fichiers.flatMap((x) => readdirSync(MIG).filter((f) => f.startsWith(`${x.replace(/\.sql$/, '')}_idx_`)));
  const sql = [...fichiers, ...idx].map((f) => readFileSync(join(MIG, f), 'utf8')).join('\n').replace(/--.*$/gm, '');
  const bloc = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)![1];
  const colonnes = new Map<string, boolean>();
  for (const l of bloc.split(',\n').map((x) => x.trim()).filter(Boolean)) {
    if (/^CONSTRAINT\b/i.test(l)) continue;
    const [nom] = l.split(/\s+/);
    colonnes.set(nom, /NOT NULL|PRIMARY KEY/i.test(l));
  }
  for (const m of sql.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS (\\w+) ([^;]+);`, 'g'))) colonnes.set(m[1], /NOT NULL/i.test(m[2]));
  // Lot 64A : une contrainte remplacée (DROP puis ADD, 0459) n'est comptée qu'une fois.
  const checks = [...new Set([...sql.matchAll(/CONSTRAINT (\w+)\s+CHECK/g)].map((m) => m[1]).filter((n) => n.startsWith(table)))];
  const supprimes = new Set([...sql.matchAll(/DROP INDEX (?:CONCURRENTLY )?IF EXISTS (\w+)/g)].map((m) => m[1]));
  const index = [...sql.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?IF NOT EXISTS (\\w+)\\s+ON ${table}\\b`, 'g'))].map((m) => m[1])
    .filter((n) => !supprimes.has(n));
  return { colonnes, checks, index };
}

/** Lot 40 : migrations postérieures à la création d'une table, lues avec elle. */
const SUITES: Readonly<Record<string, readonly string[]>> = {
  // Lot 64A : clé d'idempotence et nouveau type (fin d'accès Duo).
  transactional_email_jobs: ['0459_duo_membership_ended_email.sql'],
  // (0462 et 0477 ne font que remplacer la contrainte de type, même nom.)
  // Lot 49B : couverture réelle de la source, état de réparation (0329).
  document_source_units: ['0329_t1_source_verification.sql'],
  document_extraction_coverage: ['0329_t1_source_verification.sql'],
  // Lot 41 : issue T3 des candidats (0321).
  // Lot 47A (O9) : index de lecture du BO diagnostic (0325).
  document_operation_candidates: ['0320_document_operation_candidates_t3.sql', '0321_document_operation_candidates_t3_outcome.sql', '0325_operation_diagnostics.sql', '0379_operations_t3_retry_cards.sql'],
  business_operations: ['0325_operation_diagnostics.sql'],
  // Lot 44 (O5) : ancre historique du Sinistre et clé stable des lignes de ses listes (0323).
  business_operation_claim_details: ['0323_claim_operations.sql'],
  business_operation_claim_damages: ['0323_claim_operations.sql'],
  business_operation_claim_actions: ['0323_claim_operations.sql'],
  business_operation_claim_exchanges: ['0323_claim_operations.sql'],
};

const CAS: Array<[PgTable, string, string]> = [
  [agendaItemRemovals, '0223_agenda_functional_key_removals.sql', 'agenda_item_removals'],
  [aiMasterCorpusRuns, '0224_ai_master_corpus_runs.sql', 'ai_master_corpus_runs'],
  [cdc15MigrationRuns, '0225_cdc15_migration_report.sql', 'cdc15_migration_runs'],
  [cdc15MigrationReport, '0225_cdc15_migration_report.sql', 'cdc15_migration_report'],
  [cdc15MigrationBackups, '0225_cdc15_migration_report_backups.sql', 'cdc15_migration_backups'],
  [roomMergeRuns, '0229_rooms_to_substructures.sql', 'room_merge_runs'],
  [roomMergeChanges, '0229_rooms_to_substructures.sql', 'room_merge_changes'],
  // Lot 28 : valeur retenue des données documentaires du catalogue « À traiter ».
  [documentFieldValues, '0256_to_process_document_rules.sql', 'document_field_values'],
  // Lot 34F : couche A de T1 (unités de la source, couverture, faits non résolus).
  [documentSourceUnits, '0295_document_source_units.sql', 'document_source_units'],
  [documentExtractionCoverage, '0295_document_source_units.sql', 'document_extraction_coverage'],
  [documentUnresolvedFacts, '0296_document_unresolved_facts.sql', 'document_unresolved_facts'],
  // Lot 39 (O1) : socle des Opérations métier (CDC Opérations V1 C20).
  [businessOperationTypes, '0316_business_operations.sql', 'business_operation_types'],
  [businessOperations, '0316_business_operations.sql', 'business_operations'],
  [businessOperationSources, '0316_business_operations.sql', 'business_operation_sources'],
  [businessOperationAssetLinks, '0316_business_operations.sql', 'business_operation_asset_links'],
  [businessOperationEquipmentLinks, '0316_business_operations.sql', 'business_operation_equipment_links'],
  [businessOperationFinancialComponents, '0316_business_operations.sql', 'business_operation_financial_components'],
  [businessOperationFinancialComponentSources, '0316_business_operations.sql', 'business_operation_financial_component_sources'],
  [businessOperationHistory, '0316_business_operations.sql', 'business_operation_history'],
  [businessOperationProjectionSuppressions, '0316_business_operations.sql', 'business_operation_projection_suppressions'],
  [businessOperationReferences, '0316_business_operations.sql', 'business_operation_references'],
  [documentOperationCandidates, '0317_business_operation_details.sql', 'document_operation_candidates'],
  [businessOperationMatchDecisions, '0317_business_operation_details.sql', 'business_operation_match_decisions'],
  [businessOperationContractDetails, '0317_business_operation_details.sql', 'business_operation_contract_details'],
  [businessOperationFinancingDetails, '0317_business_operation_details.sql', 'business_operation_financing_details'],
  [businessOperationClaimDetails, '0317_business_operation_details.sql', 'business_operation_claim_details'],
  [businessOperationClaimDamages, '0317_business_operation_details.sql', 'business_operation_claim_damages'],
  [businessOperationClaimDamageDocuments, '0317_business_operation_details.sql', 'business_operation_claim_damage_documents'],
  [businessOperationClaimDamagePhotos, '0317_business_operation_details.sql', 'business_operation_claim_damage_photos'],
  [businessOperationClaimActions, '0317_business_operation_details.sql', 'business_operation_claim_actions'],
  [businessOperationClaimExchanges, '0317_business_operation_details.sql', 'business_operation_claim_exchanges'],
  // Lot 43 (O4) : repères de la migration structurée des Opérations (C23.1).
  [businessOperationAssetDataMarks, '0322_asset_sale_fields_operations_data.sql', 'business_operation_asset_data_marks'],
  // Lot 44 (O5) : repères de la migration C14.3 de l'ancien formulaire Sinistre.
  [businessOperationClaimMigrationMarks, '0323_claim_operations.sql', 'business_operation_claim_migration_marks'],
  // Lot 49A : rattrapages ciblés du catalogue Stripe.
  [stripeCatalogRecoveries, '0326_stripe_catalog_recoveries.sql', 'stripe_catalog_recoveries'],
  // Lot 57A : e-mails indispensables durables et événements Resend.
  [transactionalEmailJobs, '0405_transactional_email_reliability.sql', 'transactional_email_jobs'],
  [emailProviderEvents, '0405_transactional_email_reliability.sql', 'email_provider_events'],
  // Lot 61 : extract brut déterministe T1 et états de phases.
  [documentRawExtracts, '0435_t1_raw_extract.sql', 'document_raw_extracts'],
  // Lot 68C : rappel J−7 avant renouvellement annuel (couverture, décisions).
  [annualRenewalReminderState, '0477_annual_renewal_reminder.sql', 'annual_renewal_reminder_state'],
  [annualRenewalReminderChecks, '0477_annual_renewal_reminder.sql', 'annual_renewal_reminder_checks'],
];

describe('tables neuves : Drizzle = SQL', () => {
  for (const [table, file, nom] of CAS) {
    it(nom, () => {
      const cfg = getTableConfig(table);
      const s = sqlTable(file, nom);
      expect(cfg.name).toBe(nom);
      expect(Object.fromEntries(cfg.columns.map((c) => [c.name, c.notNull || c.primary])))
        .toEqual(Object.fromEntries(s.colonnes));
      expect(cfg.checks.map((c) => c.name).sort()).toEqual(s.checks.length ? s.checks.sort() : cfg.checks.map((c) => c.name).sort());
      expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual(s.index.sort());
    });
  }
  it('contraintes de 0224 (posées par ALTER) déclarées', () => {
    const sql = readFileSync(join(MIG, '0224_ai_master_corpus_runs.sql'), 'utf8');
    const attendues = [...sql.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]).sort();
    expect(getTableConfig(aiMasterCorpusRuns).checks.map((c) => c.name).sort()).toEqual(attendues);
  });
});
