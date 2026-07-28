/**
 * Définitions Drizzle des tables du socle IA — CDC §5.1, §5.4, §5.7.
 *
 * ⚠️ Ajouter `export * from './ai-schema';` à la fin de `src/db/schema.ts`
 *    pour que drizzle-kit et drizzle-studio les voient (même convention que
 *    `verebona-schema.ts`). Le runtime s'appuie sur les migrations 0101-0104
 *    appliquées par `ensureMigrations()`.
 */
import {
  pgTable, serial, integer, text, boolean, jsonb, uuid, index, uniqueIndex,
  timestamp as pgTimestamp,
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
  evidenceExcerpt: text('evidence_excerpt').notNull(),
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
