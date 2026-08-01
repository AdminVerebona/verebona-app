import { sql } from 'drizzle-orm';
/**
 * Définitions Drizzle des tables de l'assistant Verebona — CDC §28.
 *
 * Conventions alignées sur `src/db/schema.ts` (serial PK, pgTimestamp, jsonb).
 * ⚠️ Pour que drizzle-kit / studio voient ces tables, ajouter à la fin de
 *    `src/db/schema.ts` :  export * from './verebona-schema';
 *    (voir patches/MODIFICATIONS.md). Le runtime s'appuie sur la migration SQL
 *    0100_verebona_assistant.sql via ensureMigrations().
 */
import {
  pgTable, serial, integer, text, boolean, real, jsonb, index, uniqueIndex,
  timestamp as pgTimestamp, primaryKey,
} from 'drizzle-orm/pg-core';

export const verebonaConversations = pgTable('verebona_conversations', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  status: text('status').notNull().default('active'),
  machineState: text('machine_state').notNull().default('IDLE'),
  contextJson: jsonb('context_json').notNull().default({}),
  clarificationStateJson: jsonb('clarification_state_json'),
  locale: text('locale').notNull().default('fr-FR'),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: pgTimestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: pgTimestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  // ⚠️ INDEX PARTIEL — le prédicat est indispensable.
  //
  // `.where(undefined as never)` ne produisait AUCUN prédicat : `drizzle-kit
  // push` créait donc un index unique sur `account_id` seul, et un compte ne
  // pouvait avoir qu'UNE conversation — jamais une conversation ACTIVE.
  //
  // Conséquence observée : après un effacement d'historique (§24.5), la
  // conversation passe en `deleted` et aucune nouvelle ne peut être créée.
  // L'assistant écrivait dans un historique effacé.
  //
  // La migration 0100 posait le bon index, mais `push` s'exécute avant elle
  // et son `IF NOT EXISTS` ne corrige pas un index déjà présent.
  activeAccount: uniqueIndex('verebona_conversations_active_account_uidx')
    .on(t.accountId)
    .where(sql`status = 'active'`),
  expiresIdx: index('verebona_conversations_expires_idx').on(t.expiresAt),
}));

export const verebonaMessages = pgTable('verebona_messages', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').notNull(),
  accountId: integer('account_id').notNull(),
  authorUserId: integer('author_user_id'),
  role: text('role').notNull(),
  status: text('status').notNull().default('pending'),
  content: text('content'),
  intent: text('intent'),
  mode: text('mode'),
  supportLevel: text('support_level'),
  requestId: text('request_id'),
  clientRequestId: text('client_request_id'),
  parentMessageId: integer('parent_message_id'),
  intentCatalogVersion: text('intent_catalog_version'),
  actionCatalogVersion: text('action_catalog_version'),
  schemaVersion: text('schema_version'),
  responseLocale: text('response_locale'),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: pgTimestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  convCreated: index('verebona_messages_conversation_created_idx').on(t.conversationId, t.createdAt),
  statusIdx: index('verebona_messages_status_idx').on(t.status),
  expiresIdx: index('verebona_messages_expires_idx').on(t.expiresAt),
}));

export const verebonaMessageClaims = pgTable('verebona_message_claims', {
  id: serial('id').primaryKey(),
  messageId: integer('message_id').notNull(),
  claimKey: text('claim_key').notNull(),
  claimText: text('claim_text').notNull(),
  derivation: text('derivation').notNull(),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ messageIdx: index('verebona_message_claims_message_idx').on(t.messageId) }));

export const verebonaMessageSources = pgTable('verebona_message_sources', {
  id: serial('id').primaryKey(),
  messageId: integer('message_id').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  sourceVersion: text('source_version'),
  titleSnapshot: text('title_snapshot'),
  excerptSnapshot: text('excerpt_snapshot'),
  rank: integer('rank'),
  relevanceScore: real('relevance_score'),
  isAvailable: boolean('is_available').notNull().default(true),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  messageIdx: index('verebona_message_sources_message_idx').on(t.messageId),
  typeIdIdx: index('verebona_message_sources_type_id_idx').on(t.sourceType, t.sourceId),
}));

export const verebonaClaimSources = pgTable('verebona_claim_sources', {
  claimId: integer('claim_id').notNull(),
  messageSourceId: integer('message_source_id').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.claimId, t.messageSourceId] }) }));

export const verebonaMessageActions = pgTable('verebona_message_actions', {
  id: serial('id').primaryKey(),
  messageId: integer('message_id').notNull(),
  actionType: text('action_type').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  label: text('label').notNull(),
  payloadJson: jsonb('payload_json').notNull().default({}),
  resolvedHref: text('resolved_href'),
  requiresConfirmation: boolean('requires_confirmation').notNull().default(false),
  analyticsCode: text('analytics_code'),
  expiresAt: pgTimestamp('expires_at', { withTimezone: true }),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  messageIdx: index('verebona_message_actions_message_idx').on(t.messageId),
  expiresIdx: index('verebona_message_actions_expires_idx').on(t.expiresAt),
}));

export const verebonaRequestRuns = pgTable('verebona_request_runs', {
  id: serial('id').primaryKey(),
  requestId: text('request_id').notNull(),
  clientRequestId: text('client_request_id'),
  conversationId: integer('conversation_id'),
  accountId: integer('account_id').notNull(),
  userId: integer('user_id'),
  intent: text('intent'),
  intentCatalogVersion: text('intent_catalog_version'),
  mode: text('mode'),
  machineFinalState: text('machine_final_state'),
  retrievalMethodsJson: jsonb('retrieval_methods_json'),
  candidateCount: integer('candidate_count'),
  sourceCount: integer('source_count'),
  cacheHit: boolean('cache_hit'),
  latencyMs: integer('latency_ms'),
  status: text('status'),
  errorCode: text('error_code'),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  accountIdx: index('verebona_request_runs_account_idx').on(t.accountId, t.createdAt),
  requestIdx: index('verebona_request_runs_request_idx').on(t.requestId),
}));

export const verebonaAiRuns = pgTable('verebona_ai_runs', {
  id: serial('id').primaryKey(),
  requestId: text('request_id').notNull(),
  accountId: integer('account_id').notNull(),
  messageId: integer('message_id'),
  provider: text('provider'),
  modelAlias: text('model_alias'),
  resolvedModelId: text('resolved_model_id'),
  routeReason: text('route_reason'),
  promptId: text('prompt_id'),
  promptVersion: text('prompt_version'),
  promptHash: text('prompt_hash'),
  schemaVersion: text('schema_version'),
  intentCatalogVersion: text('intent_catalog_version'),
  actionCatalogVersion: text('action_catalog_version'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  estimatedCostMicros: integer('estimated_cost_micros'),
  latencyMs: integer('latency_ms'),
  fallbackUsed: boolean('fallback_used'),
  attemptNumber: integer('attempt_number'),
  status: text('status'),
  errorCode: text('error_code'),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  accountIdx: index('verebona_ai_runs_account_idx').on(t.accountId, t.createdAt),
  modelIdx: index('verebona_ai_runs_model_idx').on(t.resolvedModelId, t.createdAt),
}));

export const verebonaFeedback = pgTable('verebona_feedback', {
  id: serial('id').primaryKey(),
  messageId: integer('message_id').notNull(),
  accountId: integer('account_id').notNull(),
  userId: integer('user_id'),
  value: text('value').notNull(),
  reason: text('reason'),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  messageUser: uniqueIndex('verebona_feedback_message_user_uidx').on(t.messageId, t.userId),
}));

export const verebonaHelpEntries = pgTable('verebona_help_entries', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  locale: text('locale').notNull().default('fr-FR'),
  contentVersion: text('content_version').notNull(),
  title: text('title').notNull(),
  questionPatterns: jsonb('question_patterns').notNull().default([]),
  shortAnswer: text('short_answer').notNull(),
  detailedAnswer: text('detailed_answer'),
  planScope: jsonb('plan_scope').notNull().default([]),
  actionsJson: jsonb('actions_json').notNull().default([]),
  appVersion: text('app_version'),
  status: text('status').notNull().default('draft'),
  validatedBy: text('validated_by'),
  validatedAt: pgTimestamp('validated_at', { withTimezone: true }),
  updatedAt: pgTimestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugLocale: uniqueIndex('verebona_help_entries_slug_locale_uidx').on(t.slug, t.locale),
  statusIdx: index('verebona_help_entries_status_idx').on(t.status, t.locale),
}));
