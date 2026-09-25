/**
 * Définitions Drizzle des tables du socle IA — CDC §5.1, §5.4, §5.7.
 *
 * ⚠️ Ajouter `export * from './ai-schema';` à la fin de `src/db/schema.ts`
 *    pour que drizzle-kit et drizzle-studio les voient (même convention que
 *    `verebona-schema.ts`). Le runtime s'appuie sur les migrations 0101-0104
 *    appliquées par `ensureMigrations()`.
 */
import {
  pgTable, serial, bigserial, integer, bigint, numeric, text, boolean, jsonb, uuid, index, uniqueIndex,
  date as pgDate, timestamp as pgTimestamp,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => pgTimestamp(name, { withTimezone: true }).notNull().defaultNow();
const tstzOptional = (name: string) => pgTimestamp(name, { withTimezone: true });

/** Les cinq usages IA — référentiel exposé à l'administration (§5.1). */
export const aiUseCases = pgTable('ai_use_cases', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  purpose: text('purpose').notNull(),
  replacesLegacyUsages: jsonb('replaces_legacy_usages').$type<number[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
});

/** Opérations techniques rattachées à un usage — jamais un usage réglementaire. */
export const aiOperations = pgTable('ai_operations', {
  operationCode: text('operation_code').primaryKey(),
  useCaseCode: text('use_case_code').notNull().references(() => aiUseCases.code, { onDelete: 'restrict' }),
  label: text('label').notNull(),
  provider: text('provider').notNull(),
  primaryModel: text('primary_model').notNull(),
  fallbackModels: jsonb('fallback_models').$type<string[]>().notNull().default([]),
  promptCode: text('prompt_code'),
  timeoutMs: integer('timeout_ms').notNull().default(30_000),
  outputSchema: text('output_schema').notNull().default('none'),
  active: boolean('active').notNull().default(true),
  billable: boolean('billable').notNull().default(false),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (t) => ({
  useCaseIdx: index('ai_operations_use_case_idx').on(t.useCaseCode),
  activeIdx: index('ai_operations_active_idx').on(t.active),
}));

/** Provenance des valeurs — §5.4.2. */
export const fieldEvidence = pgTable('field_evidence', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  assetId: integer('asset_id').notNull(),
  fieldKey: text('field_key').notNull(),
  valueJson: jsonb('value_json').notNull(),
  normalizedValue: text('normalized_value'),
  sourceType: text('source_type').notNull(),
  sourceId: integer('source_id').notNull(),
  sourceVersion: integer('source_version'),
  sourceLocation: jsonb('source_location').notNull().default({}),
  /** NULL pour une observation visuelle (0161) : jamais de citation inventée. */
  evidenceExcerpt: text('evidence_excerpt'),
  /** TEXT_EXTRACTION | VISUAL_ANALYSIS — migration 0161. */
  evidenceOrigin: text('evidence_origin').notNull().default('TEXT_EXTRACTION'),
  visualEvidence: jsonb('visual_evidence'),
  documentType: text('document_type'),
  documentDate: tstzOptional('document_date'),
  provider: text('provider'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  confidence: text('confidence').notNull(),
  authorityScore: integer('authority_score').notNull().default(0),
  extractedAt: tstz('extracted_at'),
  status: text('status').notNull().default('active'),
  operationTraceId: uuid('operation_trace_id'),
  fingerprint: text('fingerprint').notNull(),
}, (t) => ({
  fingerprintUidx: uniqueIndex('field_evidence_fingerprint_uidx').on(t.fingerprint),
  accountIdx: index('field_evidence_account_idx').on(t.accountId),
  assetFieldIdx: index('field_evidence_asset_field_idx').on(t.assetId, t.fieldKey),
  statusIdx: index('field_evidence_status_idx').on(t.status),
  sourceIdx: index('field_evidence_source_idx').on(t.sourceType, t.sourceId),
}));

/** Cache d'idempotence des appels modèles — §5.7. */
export const aiOperationIdempotency = pgTable('ai_operation_idempotency', {
  keyHash: text('key_hash').primaryKey(),
  resultJson: jsonb('result_json').notNull(),
  createdAt: tstz('created_at'),
  expiresAt: pgTimestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  expiresIdx: index('ai_operation_idempotency_expires_idx').on(t.expiresAt),
}));

/**
 * T1 — représentation durable d'un document (migration 0139).
 * Écrite par `services/ai/knowledge/document-knowledge.service.ts` (SQL
 * direct) ; déclarée ici pour drizzle-kit / studio.
 *
 * Types alignés sur la migration (DATE, BIGINT, NUMERIC, BIGSERIAL). Les clés
 * étrangères (accounts, asset_files, document_analysis_runs,
 * document_extractions — ON DELETE CASCADE / SET NULL) sont portées par la
 * migration ; comme pour `verebona-schema.ts`, elles ne sont pas redéclarées
 * ici (ce fichier est réexporté par `schema.ts` : l'importer créerait un cycle).
 */
export const documentExtractions = pgTable('document_extractions', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  fileId: integer('file_id').notNull(),
  analysisRunId: integer('analysis_run_id'),
  assetIdAtAnalysis: integer('asset_id_at_analysis'),
  engine: text('engine').notNull().default('source_analysis'),
  sourceType: text('source_type').notNull().default('asset_file'),
  sourceVersion: integer('source_version'),
  title: text('title'),
  description: text('description'),
  documentDate: pgDate('document_date', { mode: 'string' }),
  supplierName: text('supplier_name'),
  supplierSiret: text('supplier_siret'),
  amountCents: bigint('amount_cents', { mode: 'number' }),
  currency: text('currency').notNull().default('EUR'),
  fullText: text('full_text'),
  fullTextChars: integer('full_text_chars').notNull().default(0),
  /** Observations visuelles, distinctes du texte lu (0161). */
  visualSummary: text('visual_summary'),
  visualObservations: jsonb('visual_observations').notNull().default([]),
  documentTypeCode: text('document_type_code'),
  rubricCode: text('rubric_code'),
  hasExploitableContent: boolean('has_exploitable_content').notNull().default(true),
  structuralEvidence: jsonb('structural_evidence').notNull().default({}),
  metadata: jsonb('metadata').notNull().default({}),
  factCount: integer('fact_count').notNull().default(0),
  provider: text('provider'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  operationTraceId: text('operation_trace_id'),
  extractedAt: tstz('extracted_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (t) => ({
  fileUidx: uniqueIndex('document_extractions_file_uidx').on(t.fileId),
  accountIdx: index('document_extractions_account_idx').on(t.accountId),
}));

export const documentFacts = pgTable('document_facts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accountId: integer('account_id').notNull(),
  fileId: integer('file_id').notNull(),
  extractionId: integer('extraction_id').notNull(),
  factKey: text('fact_key').notNull(),
  subject: text('subject'),
  attribute: text('attribute'),
  label: text('label'),
  valueText: text('value_text'),
  valueNumber: numeric('value_number'),
  valueUnit: text('value_unit'),
  valueJson: jsonb('value_json'),
  normalizedValue: text('normalized_value'),
  periodStart: pgDate('period_start', { mode: 'string' }),
  periodEnd: pgDate('period_end', { mode: 'string' }),
  confidence: text('confidence').notNull(),
  /** NULL pour une observation visuelle (0161) — contrainte document_facts_evidence_ck. */
  excerpt: text('excerpt'),
  location: jsonb('location').notNull().default({}),
  /** TEXT_EXTRACTION | VISUAL_ANALYSIS — 0161. */
  evidenceOrigin: text('evidence_origin').notNull().default('TEXT_EXTRACTION'),
  visualEvidence: jsonb('visual_evidence'),
  sourceType: text('source_type').notNull().default('asset_file'),
  provider: text('provider'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  status: text('status').notNull().default('active'),
  /** T1_EXTRACTION (défaut) | REVALIDATION_T2 — migration 0156. */
  provenance: text('provenance').notNull().default('T1_EXTRACTION'),
  revalidationId: integer('revalidation_id'),
  createdAt: tstz('created_at'),
}, (t) => ({
  fileIdx: index('document_facts_file_idx').on(t.fileId, t.status),
}));

/** Tableaux T1, structure ligne/colonne conservée — migration 0162. */
export const documentTables = pgTable('document_tables', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accountId: integer('account_id').notNull(),
  fileId: integer('file_id').notNull(),
  extractionId: integer('extraction_id').notNull(),
  tableIndex: integer('table_index').notNull(),
  title: text('title'),
  pageStart: integer('page_start'),
  pageEnd: integer('page_end'),
  columnCount: integer('column_count').notNull(),
  rowCount: integer('row_count').notNull(),
  columns: jsonb('columns').notNull().default([]),
  confidence: text('confidence').notNull().default('certain'),
  uncertain: boolean('uncertain').notNull().default(false),
  issues: jsonb('issues').notNull().default([]),
  sourceVersion: integer('source_version'),
  provider: text('provider'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  status: text('status').notNull().default('active'),
  createdAt: tstz('created_at'),
}, (t) => ({
  fileIdx: index('document_tables_file_idx').on(t.fileId, t.status),
}));

export const documentTableCells = pgTable('document_table_cells', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tableId: bigint('table_id', { mode: 'number' }).notNull(),
  accountId: integer('account_id').notNull(),
  fileId: integer('file_id').notNull(),
  rowIndex: integer('row_index').notNull(),
  columnIndex: integer('column_index').notNull(),
  rowHeader: text('row_header'),
  columnHeader: text('column_header'),
  columnPath: jsonb('column_path').notNull().default([]),
  /** NULL = cellule vide (is_empty) — jamais de décalage. */
  valueText: text('value_text'),
  normalizedValue: text('normalized_value'),
  valueType: text('value_type'),
  isEmpty: boolean('is_empty').notNull().default(false),
  colspan: integer('colspan').notNull().default(1),
  rowspan: integer('rowspan').notNull().default(1),
  page: integer('page'),
  confidence: text('confidence').notNull().default('certain'),
}, (t) => ({
  posUidx: uniqueIndex('document_table_cells_pos_uidx').on(t.tableId, t.rowIndex, t.columnIndex),
}));

/** Revalidations ciblées par T2 (trace + déduplication) — migration 0156. */
export const verebonaFactRevalidations = pgTable('verebona_fact_revalidations', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  userId: integer('user_id'),
  conversationId: integer('conversation_id'),
  requestId: text('request_id'),
  fileId: integer('file_id').notNull(),
  factId: bigint('fact_id', { mode: 'number' }).notNull(),
  extractionId: integer('extraction_id'),
  extractionVersion: text('extraction_version'),
  factKey: text('fact_key').notNull(),
  question: text('question'),
  triggerReason: text('trigger_reason').notNull(),
  initialValue: text('initial_value'),
  initialConfidence: text('initial_confidence'),
  mode: text('mode').notNull(),
  status: text('status').notNull(),
  newValue: text('new_value'),
  newUnit: text('new_unit'),
  newConfidence: text('new_confidence'),
  excerpt: text('excerpt'),
  page: integer('page'),
  provenance: text('provenance').notNull().default('REVALIDATION_T2'),
  reinjectedFactId: bigint('reinjected_fact_id', { mode: 'number' }),
  signalId: integer('signal_id'),
  model: text('model'),
  aiCalls: integer('ai_calls').notNull().default(0),
  costMicros: integer('cost_micros').notNull().default(0),
  createdAt: tstz('created_at'),
}, (t) => ({
  factIdx: index('verebona_fact_revalidations_fact_idx').on(t.factId, t.createdAt),
  convIdx: index('verebona_fact_revalidations_conv_idx').on(t.conversationId),
}));

/** Signaux de lacune T1 remontés par T2 — migration 0156. */
export const t1QualitySignals = pgTable('t1_quality_signals', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  fileId: integer('file_id').notNull(),
  extractionId: integer('extraction_id'),
  analysisRunId: integer('analysis_run_id'),
  factKey: text('fact_key'),
  information: text('information'),
  problem: text('problem').notNull(),
  t2Result: jsonb('t2_result').notNull().default({}),
  t1Model: text('t1_model'),
  t1PromptVersion: text('t1_prompt_version'),
  createdAt: tstz('created_at'),
}, (t) => ({
  fileIdx: index('t1_quality_signals_file_idx').on(t.fileId, t.createdAt),
}));
