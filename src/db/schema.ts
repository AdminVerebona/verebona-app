import { pgTable, serial, integer, text, boolean, index, uniqueIndex, uuid, check, date as pgDate, time as pgTime, timestamp as pgTimestamp, json, unique, numeric, jsonb, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Timestamp helpers ────────────────────────────────────────────────────────
// All structural timestamps use TIMESTAMPTZ (not text).
// Drizzle maps these to JS Date objects on read; pass new Date() on write.
const tstz = (name: string) =>
  pgTimestamp(name, { withTimezone: true }).notNull().defaultNow();

const tstzOptional = (name: string) =>
  pgTimestamp(name, { withTimezone: true });

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  username: text('username').unique(),
  company: text('company'),
  planType: text('plan_type').notNull().default('STANDARD'),
  featureFlags: text('feature_flags'),
  isActive: boolean('is_active').notNull().default(true),
  locale: text('locale').notNull().default('fr-FR'),
  role: text('role').notNull().default('USER'),
  status: text('status').notNull().default('ACTIVE'),
  lastLoginAt: tstzOptional('last_login_at'),
  acceptedTermsAt: tstzOptional('accepted_terms_at'),
  termsVersion: text('terms_version'),
  hasSeenUploadNotice: boolean('has_seen_upload_notice').notNull().default(false),
  guideAutoOpenDisabled: boolean('guide_auto_open_disabled').notNull().default(false),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
});

export const assets = pgTable('assets', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  duoId: integer('duo_id').references(() => duoAccounts.id, { onDelete: 'set null' }),
  lockState: text('lock_state').notNull().default('NONE'),
  scope: text('scope').notNull().default('personal'),
  deletedAt: tstzOptional('deleted_at'),
  copySourceRequestId: integer('copy_source_request_id'), // FK to asset_move_requests.id — enforced via migration (circular dep prevents Drizzle ref)
  category: text('category').notNull(),
  subtype: text('subtype'),
  name: text('name').notNull(),
  purchaseDate: pgDate('purchase_date'),
  purchasePriceCents: integer('purchase_price_cents'),
  status: text('status').notNull().default('EN_SERVICE'),
  notes: text('notes'),
  thumbnailUrl: text('thumbnail_url'),
  generalCondition: text('general_condition'),
  estimatedValueCents: integer('estimated_value_cents'),
  mileageOrHours: integer('mileage_or_hours'),
  purchaseLocation: text('purchase_location'),
  warrantyEndDate: pgDate('warranty_end_date'),
  dimensions: text('dimensions'),
  engineInfo: text('engine_info'),
  equipmentList: text('equipment_list'),
  keyCharacteristics: text('key_characteristics'),
  lastMaintenanceDate: pgDate('last_maintenance_date'),
  // V7 atomic columns
  address: text('address'),
  city: text('city'),
  postalCode: text('postal_code'),
  registrationNumber: text('registration_number'),
  assetTypeId: integer('asset_type_id').references(() => assetTypes.id, { onDelete: 'set null' }),
  assetTypeSubcategoryId: integer('asset_type_subcategory_id').references(() => assetTypeSubcategories.id, { onDelete: 'set null' }),
  objectCategory: text('object_category'),
  objectDetails: text('object_details'),
  archivedReason: text('archived_reason'), // NULL | 'user' | 'transmitted'
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetTypeIdIdx: index('assets_asset_type_id_idx').on(table.assetTypeId),
  assetTypeSubcategoryIdIdx: index('assets_asset_type_subcategory_id_idx').on(table.assetTypeSubcategoryId),
  accountIdIdx: index('assets_account_id_idx').on(table.accountId),
  userIdIdx: index('assets_user_id_idx').on(table.userId),
  duoIdIdx: index('assets_duo_id_idx').on(table.duoId),
  lockStateIdx: index('assets_lock_state_idx').on(table.lockState),
  deletedAtIdx: index('assets_deleted_at_idx').on(table.deletedAt),
  accountIdScopeStatusIdx: index('assets_account_id_scope_status_idx').on(table.accountId, table.scope, table.status),
  publicIdIdx: index('assets_public_id_idx').on(table.publicId),
  scopeCheck: check('assets_scope_check', sql`${table.scope} IN ('personal', 'duo')`),
  lockStateCheck: check('assets_lock_state_check', sql`${table.lockState} IN ('NONE', 'SOFT', 'HARD')`),
  statusCheck: check('assets_status_check', sql`${table.status} IN ('EN_SERVICE', 'EN_MAINTENANCE', 'EN_PANNE', 'EN_REPARATION', 'HORS_SERVICE', 'VENDU', 'DETRUIT', 'INACTIF', 'ARCHIVED', 'TRANSMIS')`),
}));

export const rooms = pgTable('rooms', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  roomType: text('room_type').notNull(),
  area: text('area'),
  description: text('description'),
  scope: text('scope').notNull().default('personal'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetIdIdx: index('rooms_asset_id_idx').on(table.assetId),
  accountIdIdx: index('rooms_account_id_idx').on(table.accountId),
  publicIdIdx: index('rooms_public_id_idx').on(table.publicId),
  scopeIdx: index('rooms_scope_idx').on(table.scope),
  scopeCheck: check('rooms_scope_check', sql`${table.scope} IN ('personal', 'duo')`),
}));

// ⚠️ DEPRECATED: Table documents supprimée - utiliser asset_files à la place
export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  fileUrl: text('file_url').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  fileSize: integer('file_size'),
  documentType: text('document_type').notNull(),
  documentDate: pgDate('document_date'),
  description: text('description'),
  createdAt: tstz('created_at'),
});

export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
  linkedAssetId: integer('linked_asset_id').references(() => assets.id, { onDelete: 'cascade' }),
  linkedRoomId: integer('linked_room_id').references(() => rooms.id, { onDelete: 'cascade' }),
  categorie: text('categorie').notNull(),
  title: text('titre').notNull(),
  date: pgDate('date_evenement'),
  substructureId: integer('substructure_id').references(() => substructures.id, { onDelete: 'set null' }),
  equipmentId: integer('equipment_id').references(() => equipments.id, { onDelete: 'set null' }),
  statut: text('statut').notNull().default('realise'),
  important: boolean('important').notNull().default(false),
  provider: text('provider'),
  costCents: integer('cost_cents'),
  notes: text('notes'),
  description: text('description'),
  scope: text('scope').notNull().default('personal'),
  isDraft: boolean('is_draft').notNull().default(false),
  isIgnored: boolean('is_ignored').notNull().default(false),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('events_account_id_idx').on(table.accountId),
  assetIdIdx: index('events_asset_id_idx').on(table.assetId),
  linkedAssetIdIdx: index('events_linked_asset_id_idx').on(table.linkedAssetId),
  linkedRoomIdIdx: index('events_linked_room_id_idx').on(table.linkedRoomId),
  dateEvenementIdx: index('events_date_evenement_idx').on(table.date),
  statutIdx: index('events_statut_idx').on(table.statut),
  categorieIdx: index('events_categorie_idx').on(table.categorie),
  publicIdIdx: index('events_public_id_idx').on(table.publicId),
  scopeIdx: index('events_scope_idx').on(table.scope),
  scopeCheck: check('events_scope_check', sql`${table.scope} IN ('personal', 'duo')`),
}));

export const calendarAdditions = pgTable('calendar_additions', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventId: integer('event_id').references(() => events.id, { onDelete: 'cascade' }),
  deadlineId: integer('deadline_id').references(() => deadlines.id, { onDelete: 'cascade' }),
  lastAddedAt: tstz('last_added_at'),
  provider: text('provider').notNull(),
  dismissedAt: tstzOptional('dismissed_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('calendar_additions_account_id_idx').on(table.accountId),
  userIdIdx: index('calendar_additions_user_id_idx').on(table.userId),
  eventIdIdx: index('calendar_additions_event_id_idx').on(table.eventId),
  deadlineIdIdx: index('calendar_additions_deadline_id_idx').on(table.deadlineId),
}));

export const deadlines = pgTable('deadlines', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
  linkedAssetId: integer('linked_asset_id').references(() => assets.id, { onDelete: 'cascade' }),
  linkedRoomId: integer('linked_room_id').references(() => rooms.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  deadlineDate: pgDate('deadline_date'),
  deadlineType: text('deadline_type'),
  substructureId: integer('substructure_id').references(() => substructures.id, { onDelete: 'set null' }),
  equipmentId: integer('equipment_id').references(() => equipments.id, { onDelete: 'set null' }),
  isDone: boolean('is_done').notNull().default(false),
  doneDate: pgDate('done_date'),
  notes: text('notes'),
  scope: text('scope').notNull().default('personal'),
  isDraft: boolean('is_draft').notNull().default(false),
  isIgnored: boolean('is_ignored').notNull().default(false),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('deadlines_account_id_idx').on(table.accountId),
  assetIdIdx: index('deadlines_asset_id_idx').on(table.assetId),
  linkedAssetIdIdx: index('deadlines_linked_asset_id_idx').on(table.linkedAssetId),
  linkedRoomIdIdx: index('deadlines_linked_room_id_idx').on(table.linkedRoomId),
  publicIdIdx: index('deadlines_public_id_idx').on(table.publicId),
  scopeIdx: index('deadlines_scope_idx').on(table.scope),
  scopeCheck: check('deadlines_scope_check', sql`${table.scope} IN ('personal', 'duo')`),
}));

export const substructures = pgTable('substructures', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  orderIndex: integer('order_index').notNull().default(0),
  scope: text('scope').notNull().default('personal'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetIdIdx: index('substructures_asset_id_idx').on(table.assetId),
  publicIdIdx: index('substructures_public_id_idx').on(table.publicId),
  scopeIdx: index('substructures_scope_idx').on(table.scope),
  scopeCheck: check('substructures_scope_check', sql`${table.scope} IN ('personal', 'duo')`),
}));

export const equipments = pgTable('equipments', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  substructureId: integer('substructure_id').references(() => substructures.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  type: text('type'),
  category: text('category'),
  purchasePriceCents: integer('purchase_price_cents'),
  estimatedValueCents: integer('estimated_value_cents'),
  status: text('status').notNull().default('EN_SERVICE'),
  archivedAt: tstzOptional('archived_at'),
  scope: text('scope').notNull().default('personal'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetIdIdx: index('equipments_asset_id_idx').on(table.assetId),
  substructureIdIdx: index('equipments_substructure_id_idx').on(table.substructureId),
  publicIdIdx: index('equipments_public_id_idx').on(table.publicId),
  scopeIdx: index('equipments_scope_idx').on(table.scope),
  scopeCheck: check('equipments_scope_check', sql`${table.scope} IN ('personal', 'duo')`),
}));

export const assetTypes = pgTable('asset_types', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  icon: text('icon'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
});

export const assetTypeSubcategories = pgTable('asset_type_subcategories', {
  id: serial('id').primaryKey(),
  assetTypeId: integer('asset_type_id').notNull().references(() => assetTypes.id),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  icon: text('icon'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
});

export const emailTemplates = pgTable('email_templates', {
  id: serial('id').primaryKey(),
  type: text('type').notNull().unique(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  placeholders: text('placeholders'),
  triggerConfig: text('trigger_config'),
  sender: text('sender'),
  updatedAt: tstz('updated_at'),
  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export const adminAuditLog = pgTable('admin_audit_log', {
  id: serial('id').primaryKey(),
  timestamp: tstz('timestamp'),
  adminUserId: integer('admin_user_id').references(() => users.id, { onDelete: 'set null' }),
  adminEmail: text('admin_email').notNull(),
  actionType: text('action_type').notNull(),
  targetType: text('target_type').notNull(),
  targetId: integer('target_id'),
  details: text('details'),
}, (table) => ({
  actionTypeIdx: index('admin_audit_log_action_type_idx').on(table.actionType),
  adminUserIdIdx: index('admin_audit_log_admin_user_id_idx').on(table.adminUserId),
}));

export const assetFiles = pgTable('asset_files', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
  linkedAssetId: integer('linked_asset_id').references(() => assets.id, { onDelete: 'cascade' }),
  linkedRoomId: integer('linked_room_id').references(() => rooms.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  isWebLink: boolean('is_web_link').notNull().default(false),
  webLinkUrl: text('web_link_url'),
  webLinkTitle: text('web_link_title'),
  filename: text('filename'),
  originalFilename: text('original_filename'),
  mimeType: text('mime_type'),
  fileExtension: text('file_extension'),
  size: integer('size'),
  sha256Hash: text('sha256_hash'),
  s3Key: text('s3_key'),
  s3Bucket: text('s3_bucket'),
  s3Region: text('s3_region'),
  uploadStatus: text('upload_status').default('COMPLETED'),
  /**
   * Type documentaire. NULLABLE depuis la migration 0119 : le défaut `AUTRE`
   * rendait indiscernables « type Autre choisi » et « pas encore classé »
   * (CDC 5 §1.3, constat critique).
   */
  documentType: text('document_type'),

  // ── Classement documentaire (CDC 5 §8.2, migration 0119) ────────────────
  documentCategoryId: integer('document_category_id'),
  /** CLASSIFIED | TO_CLASSIFY. État système, jamais porté par le type. */
  classificationState: text('classification_state').notNull().default('TO_CLASSIFY'),
  /** Scores internes. Jamais exposés au front utilisateur (§8.2). */
  categoryConfidence: numeric('category_confidence'),
  typeConfidence: numeric('type_confidence'),
  /** AI | USER | REFERENCE_CORRECTION. */
  categorySource: text('category_source'),
  typeSource: text('type_source'),
  /** Verrouillages du §5.2 : l'IA ne réécrit pas une correction manuelle. */
  categoryUserLocked: boolean('category_user_locked').notNull().default(false),
  typeUserLocked: boolean('type_user_locked').notNull().default(false),
  classificationUpdatedAt: tstzOptional('classification_updated_at'),
  substructureId: integer('substructure_id').references(() => substructures.id, { onDelete: 'set null' }),
  equipmentId: integer('equipment_id').references(() => equipments.id, { onDelete: 'set null' }),
  documentDate: pgDate('document_date'),
  description: text('description'),
  supplier: text('supplier'),
  amountCents: integer('amount_cents'),
  notes: text('notes'),
  metadata: text('metadata'),
  scope: text('scope').notNull().default('personal'),
  isDraft: boolean('is_draft').notNull().default(false),
  isIgnored: boolean('is_ignored').notNull().default(false),
  // V3.3 IA fields
  retainedTitle: text('retained_title'),
  retainedFunctionCode: text('retained_function_code'),
  cilRubricCodes: json('cil_rubric_codes').$type<string[]>(),
  extractedText: text('extracted_text'),
  lastAnalysisAt: pgTimestamp('last_analysis_at', { withTimezone: true }),
  // V4 — pipeline auto-analyse
  analysisState: text('analysis_state'), // null=Standard | UPLOADING | UPLOADED | ANALYZING | ANALYZED | VALIDATION_REQUIRED | CONFLICT_DETECTED | ANALYSIS_FAILED
  analysisFailReason: text('analysis_fail_reason'), // raison de l'échec, persistée si analysisState=ANALYSIS_FAILED
  analysisRetryCount: integer('analysis_retry_count').notNull().default(0), // nombre d'échecs successifs — notif envoyée au 10e
  fusionIgnoredWith: jsonb('fusion_ignored_with').$type<number[]>(),
  userEditedFields: jsonb('user_edited_fields').$type<Record<string, boolean>>(),
  uploadedAt: tstz('uploaded_at'),
  deletedAt: tstzOptional('deleted_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetIdIdx: index('asset_files_asset_id_idx').on(table.assetId),
  linkedAssetIdIdx: index('asset_files_linked_asset_id_idx').on(table.linkedAssetId),
  linkedRoomIdIdx: index('asset_files_linked_room_id_idx').on(table.linkedRoomId),
  accountIdIdx: index('asset_files_account_id_idx').on(table.accountId),
  uploadStatusIdx: index('asset_files_upload_status_idx').on(table.uploadStatus),
  deletedAtIdx: index('asset_files_deleted_at_idx').on(table.deletedAt),
  isWebLinkIdx: index('asset_files_is_web_link_idx').on(table.isWebLink),
  publicIdIdx: index('asset_files_public_id_idx').on(table.publicId),
  scopeIdx: index('asset_files_scope_idx').on(table.scope),
  // Composite index for the most common query filter: accountId + deletedAt
  accountIdDeletedAtIdx: index('asset_files_account_id_deleted_at_idx').on(table.accountId, table.deletedAt),
  scopeCheck: check('asset_files_scope_check', sql`${table.scope} IN ('personal', 'duo')`),
}));

export const documentVersions = pgTable('document_versions', {
  id: serial('id').primaryKey(),
  fileId: integer('file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  s3Key: text('s3_key').notNull(),
  s3Bucket: text('s3_bucket').notNull(),
  s3Region: text('s3_region').notNull(),
  fileSize: integer('file_size').notNull(),
  sha256Hash: text('sha256_hash').notNull(),
  changeDescription: text('change_description'),
  isCurrentVersion: boolean('is_current_version').notNull().default(true),
  createdAt: tstz('created_at'),
}, (table) => ({
  fileIdIdx: index('document_versions_file_id_idx').on(table.fileId),
  accountIdIdx: index('document_versions_account_id_idx').on(table.accountId),
  versionNumberIdx: index('document_versions_version_number_idx').on(table.versionNumber),
  uniqueFileVersion: uniqueIndex('document_versions_file_version_unique_idx').on(table.fileId, table.versionNumber),
}));

export const systemFiles = pgTable('system_files', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type').notNull(),
  fileExtension: text('file_extension').notNull(),
  size: integer('size').notNull(),
  sha256Hash: text('sha256_hash').notNull(),
  s3Key: text('s3_key').notNull(),
  s3Bucket: text('s3_bucket').notNull(),
  s3Region: text('s3_region').notNull(),
  uploadStatus: text('upload_status').notNull().default('PENDING'),
  fileType: text('file_type').notNull().default('OTHER'),
  description: text('description'),
  metadata: text('metadata'),
  uploadedAt: tstzOptional('uploaded_at'),
  deletedAt: tstzOptional('deleted_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  userIdIdx: index('system_files_user_id_idx').on(table.userId),
  uploadStatusIdx: index('system_files_upload_status_idx').on(table.uploadStatus),
  fileTypeIdx: index('system_files_file_type_idx').on(table.fileType),
  deletedAtIdx: index('system_files_deleted_at_idx').on(table.deletedAt),
}));

export const emailSettings = pgTable('email_settings', {
  id: integer('id').primaryKey(),
  emailsEnabled: boolean('emails_enabled').notNull().default(true),
  senderName: text('sender_name').notNull().default('Verebona'),
  senderEmail: text('sender_email').notNull().default('noreply@verebona.com'),
  replyToEmail: text('reply_to_email').notNull().default('support@verebona.com'),
  logoUrl: text('logo_url'),
  logoUrlLight: text('logo_url_light'),
  logoUrlDark: text('logo_url_dark'),
  footerText: text('footer_text'),
  updatedAt: tstz('updated_at'),
  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export const emailLogs = pgTable('email_logs', {
  id: serial('id').primaryKey(),
  templateCode: text('template_code').notNull(),
  recipientEmail: text('recipient_email').notNull(),
  recipientUserId: integer('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
  subject: text('subject').notNull(),
  status: text('status').notNull(),
  errorMessage: text('error_message'),
  sentAt: tstz('sent_at'),
  metadata: text('metadata'),
}, (table) => ({
  statusIdx: index('email_logs_status_idx').on(table.status),
  sentAtIdx: index('email_logs_sent_at_idx').on(table.sentAt),
  recipientUserIdIdx: index('email_logs_recipient_user_id_idx').on(table.recipientUserId),
}));

export const userActivityLog = pgTable('user_activity_log', {
  id: serial('id').primaryKey(),
  timestamp: tstz('timestamp'),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  userEmail: text('user_email').notNull(),
  activityType: text('activity_type').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  details: text('details'),
  logType: text('log_type'),
  createdAt: tstz('created_at'),
}, (table) => ({
  userIdIdx: index('user_activity_log_user_id_idx').on(table.userId),
  timestampIdx: index('user_activity_log_timestamp_idx').on(table.timestamp),
  activityTypeIdx: index('user_activity_log_activity_type_idx').on(table.activityType),
}));

export const userGuideProgress = pgTable('user_guide_progress', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stepKey: text('step_key').notNull(),
  status: text('status').notNull(), // CHECK ('completed' | 'skipped') — enforced via migration
  completedAt: tstzOptional('completed_at'),
  skippedAt: tstzOptional('skipped_at'),
  createdAt: tstz('created_at'),
}, (table) => ({
  userStepUnique: unique('user_guide_progress_user_step_unique').on(table.userId, table.stepKey),
  userIdIdx: index('user_guide_progress_user_id_idx').on(table.userId),
}));

export const subscriptionHistory = pgTable('subscription_history', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  oldTier: text('old_tier'),
  newTier: text('new_tier').notNull(),
  oldPremiumUntil: integer('old_premium_until'),
  newPremiumUntil: integer('new_premium_until'),
  oldProUntil: integer('old_pro_until'),
  newProUntil: integer('new_pro_until'),
  source: text('source').notNull(),
  stripeEventId: text('stripe_event_id'),
  createdAt: tstz('created_at'),
}, (table) => ({
  userIdIdx: index('subscription_history_user_id_idx').on(table.userId),
  createdAtIdx: index('subscription_history_created_at_idx').on(table.createdAt),
}));

export const stripeWebhookLogs = pgTable('stripe_webhook_logs', {
  id: serial('id').primaryKey(),
  eventId: text('event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(),
  processed: boolean('processed').notNull().default(true),
  errorMessage: text('error_message'),
  processingTimeMs: integer('processing_time_ms'),
  createdAt: tstz('created_at'),
}, (table) => ({
  eventTypeIdx: index('stripe_webhook_logs_event_type_idx').on(table.eventType),
  processedIdx: index('stripe_webhook_logs_processed_idx').on(table.processed),
  createdAtIdx: index('stripe_webhook_logs_created_at_idx').on(table.createdAt),
}));

export const invoices = pgTable('invoices', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stripeInvoiceId: text('stripe_invoice_id').notNull().unique(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('eur'),
  status: text('status').notNull(),
  paidAt: tstzOptional('paid_at'),
  invoicePdf: text('invoice_pdf'),
  hostedInvoiceUrl: text('hosted_invoice_url'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  userIdIdx: index('invoices_user_id_idx').on(table.userId),
  stripeCustomerIdIdx: index('invoices_stripe_customer_id_idx').on(table.stripeCustomerId),
  statusIdx: index('invoices_status_idx').on(table.status),
}));

export const planConfigs = pgTable('plan_configs', {
  id: serial('id').primaryKey(),
  planType: text('plan_type').notNull().unique(),
  maxAssets: integer('max_assets').notNull(),
  pdfDossierEnabled: boolean('pdf_dossier_enabled').notNull(),
  pdfCarnetEnabled: boolean('pdf_carnet_enabled').notNull(),
  zipExportEnabled: boolean('zip_export_enabled').notNull(),
  maintenanceTracking: text('maintenance_tracking').notNull().default('manual'),
  updatedAt: tstz('updated_at'),
});

export const subscriptionPlans = pgTable('subscription_plans', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(), // standard | premium | premium_duo | premium_pro
  label: text('label').notNull(),
  yearlyPriceCents: integer('yearly_price_cents'),
  monthlyPriceCents: integer('monthly_price_cents'),
  /** @deprecated remplace par monthlyPriceCents (affichage uniquement) */
  monthlyEquivalentCents: integer('monthly_equivalent_cents'),
  /** @deprecated remplace par stripePriceIdMonthly / stripePriceIdYearly */
  stripePriceId: text('stripe_price_id'),
  stripePriceIdMonthly: text('stripe_price_id_monthly'),
  stripePriceIdYearly: text('stripe_price_id_yearly'),
  isVisible: boolean('is_visible').notNull().default(true),
  isSubscribable: boolean('is_subscribable').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  codeIdx: index('subscription_plans_code_idx').on(table.code),
  displayOrderIdx: index('subscription_plans_display_order_idx').on(table.displayOrder),
}));

export const planLimits = pgTable('plan_limits', {
  id: serial('id').primaryKey(),
  planCode: text('plan_code').notNull(),
  maxAssets: integer('max_assets').notNull(),
  maxDocuments: integer('max_documents').notNull().default(0),
  maxUsers: integer('max_users').notNull().default(1),
  trialAnalysisQuota: integer('trial_analysis_quota').notNull(),
  yearlyAnalysisQuota: integer('yearly_analysis_quota').notNull(),
  featuresJson: jsonb('features_json').$type<Record<string, unknown>>(),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  planCodeIdx: uniqueIndex('plan_limits_plan_code_uidx').on(table.planCode),
}));

export const analysisPacks = pgTable('analysis_packs', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  creditAmount: integer('credit_amount').notNull(),
  priceCents: integer('price_cents').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  eligiblePlansJson: jsonb('eligible_plans_json').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  codeIdx: index('analysis_packs_code_idx').on(table.code),
  activeIdx: index('analysis_packs_active_idx').on(table.isActive),
}));

export const assetPhotos = pgTable('asset_photos', {
  id: serial('id').primaryKey(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fileId: integer('file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  displayOrder: integer('display_order').notNull().default(0),
  isPrimary: boolean('is_primary').notNull().default(false),
  caption: text('caption'),
  createdAt: tstz('created_at'),
}, (table) => ({
  assetIdIdx: index('asset_photos_asset_id_idx').on(table.assetId),
  fileIdIdx: index('asset_photos_file_id_idx').on(table.fileId),
}));

export const exportTemplates = pgTable('export_templates', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  templateContent: text('template_content').notNull(),
  variables: text('variables'),
  category: text('category').notNull(),
  exportType: text('export_type'),
  pdfmonkeyTemplateId: text('pdfmonkey_template_id'),
  assetTypeId: integer('asset_type_id').references(() => assetTypes.id, { onDelete: 'set null' }),
  assetTypeSubcategoryId: integer('asset_type_subcategory_id').references(() => assetTypeSubcategories.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, (table) => ({
  categoryIdx: index('export_templates_category_idx').on(table.category),
  codeIdx: index('export_templates_code_idx').on(table.code),
  exportTypeIdx: index('export_templates_export_type_idx').on(table.exportType),
  assetTypeIdIdx: index('export_templates_asset_type_id_idx').on(table.assetTypeId),
  assetTypeSubcategoryIdIdx: index('export_templates_asset_type_subcategory_id_idx').on(table.assetTypeSubcategoryId),
}));

export const systemLogos = pgTable('system_logos', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  logoType: text('logo_type').notNull(),
  contentType: text('content_type').notNull(),
  logoContent: text('logo_content').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  codeIdx: index('system_logos_code_idx').on(table.code),
  logoTypeIdx: index('system_logos_logo_type_idx').on(table.logoType),
  isActiveIdx: index('system_logos_is_active_idx').on(table.isActive),
}));

export const documentTypes = pgTable('document_types', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  codeIdx: index('document_types_code_idx').on(table.code),
  isActiveIdx: index('document_types_is_active_idx').on(table.isActive),
}));

export const documentTypeAssetAssociations = pgTable('document_type_asset_associations', {
  id: serial('id').primaryKey(),
  documentTypeId: integer('document_type_id').notNull().references(() => documentTypes.id, { onDelete: 'cascade' }),
  assetTypeId: integer('asset_type_id').references(() => assetTypes.id, { onDelete: 'cascade' }),
  assetTypeSubcategoryId: integer('asset_type_subcategory_id').references(() => assetTypeSubcategories.id, { onDelete: 'cascade' }),
  isRequired: boolean('is_required').notNull().default(false),
  createdAt: tstz('created_at'),
}, (table) => ({
  documentTypeIdIdx: index('doc_type_asset_assoc_doc_type_id_idx').on(table.documentTypeId),
  assetTypeIdIdx: index('doc_type_asset_assoc_asset_type_id_idx').on(table.assetTypeId),
  assetTypeSubcategoryIdIdx: index('doc_type_asset_assoc_asset_subcat_id_idx').on(table.assetTypeSubcategoryId),
  uniqueAssoc: uniqueIndex('doc_type_asset_assoc_unique_idx').on(table.documentTypeId, table.assetTypeId, table.assetTypeSubcategoryId),
}));

export const documentTypeExportAssociations = pgTable('document_type_export_associations', {
  id: serial('id').primaryKey(),
  documentTypeId: integer('document_type_id').notNull().references(() => documentTypes.id, { onDelete: 'cascade' }),
  exportTemplateId: integer('export_template_id').references(() => exportTemplates.id, { onDelete: 'set null' }),
  exportType: text('export_type'),
  includeByDefault: boolean('include_by_default').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: tstz('created_at'),
}, (table) => ({
  documentTypeIdIdx: index('doc_type_export_assoc_doc_type_id_idx').on(table.documentTypeId),
  exportTypeIdx: index('doc_type_export_assoc_export_type_idx').on(table.exportType),
  exportTemplateIdIdx: index('doc_type_export_assoc_export_template_id_idx').on(table.exportTemplateId),
  uniqueAssoc: uniqueIndex('doc_type_export_assoc_unique_idx').on(table.documentTypeId, table.exportTemplateId),
}));

export const eventDocuments = pgTable('event_documents', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  fileId: integer('file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  createdAt: tstz('created_at'),
}, (table) => ({
  eventIdIdx: index('event_documents_event_id_idx').on(table.eventId),
  fileIdIdx: index('event_documents_file_id_idx').on(table.fileId),
  uniqueIdx: uniqueIndex('event_documents_unique_idx').on(table.eventId, table.fileId),
}));

export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  ownerUserId: integer('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  duoAccountId: integer('duo_account_id').references(() => duoAccounts.id, { onDelete: 'set null' }),
  planType: text('plan_type').notNull().default('STANDARD'),
  planRenewalDate: tstzOptional('plan_renewal_date'),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  subscriptionTier: text('subscription_tier').notNull().default('free'),
  premiumUntil: integer('premium_until'),
  proUntil: integer('pro_until'),
  subscriptionStatus: text('subscription_status').notNull().default('NONE'),
  subscriptionStartedAt: tstzOptional('subscription_started_at'),
  featureFlags: text('feature_flags'),
  maxMembers: integer('max_members').notNull().default(1),
  isActive: boolean('is_active').notNull().default(true),
  calendarShareToken: text('calendar_share_token').unique(),
  calendarShareTokenActive: boolean('calendar_share_token_active').notNull().default(false),
  calendarShareTokenCreatedAt: tstzOptional('calendar_share_token_created_at'),
  trialConfirmationEmailSentAt: tstzOptional('trial_confirmation_email_sent_at'),
  trialEndsAt: tstzOptional('trial_ends_at'),
  pastDueGraceStartedAt: tstzOptional('past_due_grace_started_at'),
  pastDueGraceEndsAt: tstzOptional('past_due_grace_ends_at'),
  checkoutSessionId: text('checkout_session_id'),
  checkoutSessionCreatedAt: tstzOptional('checkout_session_created_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  ownerUserIdIdx: index('accounts_owner_user_id_idx').on(table.ownerUserId),
  stripeCustomerIdIdx: index('accounts_stripe_customer_id_idx').on(table.stripeCustomerId),
  subscriptionStatusIdx: index('accounts_subscription_status_idx').on(table.subscriptionStatus),
  planTypeCheck: check('accounts_plan_type_check', sql`${table.planType} IN ('STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO')`),
  subscriptionStatusCheck: check('accounts_subscription_status_check', sql`${table.subscriptionStatus} IN ('NONE','ACTIVE','CANCELED','EXPIRED','PAST_DUE','PAST_DUE_GRACE','UNPAID_RECOVERY','TRIALING')`),
}));

export const accountMemberships = pgTable('account_memberships', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  invitedEmail: text('invited_email'),
  role: text('role').notNull().default('member'),
  status: text('status').notNull().default('pending'),
  invitedBy: integer('invited_by').references(() => users.id, { onDelete: 'set null' }),
  invitedAt: tstz('invited_at'),
  joinedAt: tstzOptional('joined_at'),
  removedAt: tstzOptional('removed_at'),
  removedBy: integer('removed_by').references(() => users.id, { onDelete: 'set null' }),
  inviteToken: text('invite_token').unique(),
  inviteTokenExpiresAt: tstzOptional('invite_token_expires_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('account_memberships_account_id_idx').on(table.accountId),
  userIdIdx: index('account_memberships_user_id_idx').on(table.userId),
  statusIdx: index('account_memberships_status_idx').on(table.status),
  inviteTokenIdx: index('account_memberships_invite_token_idx').on(table.inviteToken),
  // Partial unique: one active/pending membership per (account, user) — NULL userId rows (invite-only) excluded
  uniqueActiveMembershipIdx: uniqueIndex('account_memberships_unique_active_idx')
    .on(table.accountId, table.userId)
    .where(sql`user_id IS NOT NULL`),
  roleCheck: check('account_memberships_role_check', sql`${table.role} IN ('owner', 'member', 'admin')`),
  statusCheck: check('account_memberships_status_check', sql`${table.status} IN ('pending', 'active', 'removed', 'declined')`),
}));

export const accountAuditLog = pgTable('account_audit_log', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  userEmail: text('user_email').notNull(),
  actionType: text('action_type').notNull(),
  targetUserId: integer('target_user_id').references(() => users.id, { onDelete: 'set null' }),
  targetUserEmail: text('target_user_email'),
  details: text('details'),
  timestamp: tstz('timestamp'),
}, (table) => ({
  accountIdIdx: index('account_audit_log_account_id_idx').on(table.accountId),
  userIdIdx: index('account_audit_log_user_id_idx').on(table.userId),
  timestampIdx: index('account_audit_log_timestamp_idx').on(table.timestamp),
  actionTypeIdx: index('account_audit_log_action_type_idx').on(table.actionType),
}));

export const duoAccounts = pgTable('duo_accounts', {
  id: serial('id').primaryKey(),
  billingOwnerUserId: integer('billing_owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  subscriptionStatus: text('subscription_status').notNull().default('ACTIVE'),
  activatedAt: tstzOptional('activated_at'),
  firstPaymentFailedAt: tstzOptional('first_payment_failed_at'),
  graceDeadlineAt: tstzOptional('grace_deadline_at'),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  stripeCustomerId: text('stripe_customer_id'),
  pendingInviteEmail: text('pending_invite_email'),
  pendingInviteToken: text('pending_invite_token').unique(),
  pendingInviteTokenExpiresAt: tstzOptional('pending_invite_token_expires_at'),
  pendingInviteSentAt: tstzOptional('pending_invite_sent_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  billingOwnerUserIdIdx: index('duo_accounts_billing_owner_user_id_idx').on(table.billingOwnerUserId),
  subscriptionStatusIdx: index('duo_accounts_subscription_status_idx').on(table.subscriptionStatus),
  stripeSubscriptionIdIdx: index('duo_accounts_stripe_subscription_id_idx').on(table.stripeSubscriptionId),
  pendingInviteTokenIdx: index('duo_accounts_pending_invite_token_idx').on(table.pendingInviteToken),
}));

export const duoMemberships = pgTable('duo_memberships', {
  id: serial('id').primaryKey(),
  duoId: integer('duo_id').notNull().references(() => duoAccounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('INVITED'),
  slot: integer('slot'),
  invitedAt: tstz('invited_at'),
  joinedAt: tstzOptional('joined_at'),
  leftAt: tstzOptional('left_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  duoIdIdx: index('duo_memberships_duo_id_idx').on(table.duoId),
  userIdIdx: index('duo_memberships_user_id_idx').on(table.userId),
  statusIdx: index('duo_memberships_status_idx').on(table.status),
  uniqueDuoUser: uniqueIndex('duo_memberships_duo_user_unique_idx').on(table.duoId, table.userId),
  statusCheck: check('duo_memberships_status_check', sql`${table.status} IN ('INVITED', 'ACTIVE', 'LEFT', 'REMOVED')`),
}));

export const assetMoveRequests = pgTable('asset_move_requests', {
  id: serial('id').primaryKey(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  duoId: integer('duo_id').notNull().references(() => duoAccounts.id, { onDelete: 'cascade' }),
  targetAccountId: integer('target_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  initiatorUserId: integer('initiator_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  validatorUserId: integer('validator_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('PENDING'),
  resolutionMode: text('resolution_mode'),
  copyJobStatus: text('copy_job_status').notNull().default('NONE'),
  copiedAssetId: integer('copied_asset_id').references(() => assets.id, { onDelete: 'set null' }),
  copyErrorCode: text('copy_error_code'),
  copyErrorMessage: text('copy_error_message'),
  resolvedAt: tstzOptional('resolved_at'),
  resolvedByUserId: integer('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  resolvedByType: text('resolved_by_type'),
  assetLabelSnapshot: text('asset_label_snapshot').notNull(),
  targetUserSnapshot: text('target_user_snapshot').notNull(),
  initiatorUserSnapshot: text('initiator_user_snapshot').notNull(),
  createdAt: tstz('created_at'),
}, (table) => ({
  assetIdIdx: index('asset_move_requests_asset_id_idx').on(table.assetId),
  duoIdIdx: index('asset_move_requests_duo_id_idx').on(table.duoId),
  statusIdx: index('asset_move_requests_status_idx').on(table.status),
  initiatorUserIdIdx: index('asset_move_requests_initiator_user_id_idx').on(table.initiatorUserId),
  validatorUserIdIdx: index('asset_move_requests_validator_user_id_idx').on(table.validatorUserId),
}));

export const assetDeleteRequests = pgTable('asset_delete_requests', {
  id: serial('id').primaryKey(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  duoId: integer('duo_id').notNull().references(() => duoAccounts.id, { onDelete: 'cascade' }),
  initiatorUserId: integer('initiator_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  validatorUserId: integer('validator_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('PENDING'),
  resolvedAt: tstzOptional('resolved_at'),
  resolvedByUserId: integer('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  resolvedByType: text('resolved_by_type'),
  assetLabelSnapshot: text('asset_label_snapshot').notNull(),
  initiatorUserSnapshot: text('initiator_user_snapshot').notNull(),
  createdAt: tstz('created_at'),
}, (table) => ({
  assetIdIdx: index('asset_delete_requests_asset_id_idx').on(table.assetId),
  duoIdIdx: index('asset_delete_requests_duo_id_idx').on(table.duoId),
  statusIdx: index('asset_delete_requests_status_idx').on(table.status),
  initiatorUserIdIdx: index('asset_delete_requests_initiator_user_id_idx').on(table.initiatorUserId),
  validatorUserIdIdx: index('asset_delete_requests_validator_user_id_idx').on(table.validatorUserId),
}));

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  payloadJson: text('payload_json'),
  dedupeKey: text('dedupe_key').unique(),
  mustDeliver: boolean('must_deliver').notNull().default(false),
  // ── Lot 1 — contenu rendu côté serveur (cf. CDC §12.5) ────────────────────
  // Le rendu ne dépend plus d'un switch client incomplet : le serveur produit
  // un contenu stable. `type` et `payload_json` restent conservés pour les
  // interactions spécifiques et le fallback des lignes historiques.
  outboxId: uuid('outbox_id'), // FK logique → notification_outbox.id (nullable)
  title: text('title'),
  body: text('body'),
  href: text('href'),
  category: text('category'),
  createdAt: tstz('created_at'),
  readAt: tstzOptional('read_at'),
}, (table) => ({
  userIdIdx: index('notifications_user_id_idx').on(table.userId),
  typeIdx: index('notifications_type_idx').on(table.type),
  readAtIdx: index('notifications_read_at_idx').on(table.readAt),
  createdAtIdx: index('notifications_created_at_idx').on(table.createdAt),
  outboxIdIdx: index('notifications_outbox_id_idx').on(table.outboxId),
}));

export const accountSubscriptions = pgTable('account_subscriptions', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  planCode: text('plan_code').notNull().default('standard'),
  status: text('status').notNull().default('active'), // trialing | active | readonly | past_due | canceled
  billingPeriod: text('billing_period'), // monthly | yearly — NULL pendant l'essai
  trialConsumed: boolean('trial_consumed').notNull().default(false),
  // Changement programme (CDC §10) — applique au prochain renouvellement
  scheduledPlanCode: text('scheduled_plan_code'),
  scheduledBillingPeriod: text('scheduled_billing_period'),
  scheduledChangeAt: tstzOptional('scheduled_change_at'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  trialStartedAt: tstzOptional('trial_started_at'),
  trialEndsAt: tstzOptional('trial_ends_at'),
  currentPeriodStartAt: tstzOptional('current_period_start_at'),
  currentPeriodEndAt: tstzOptional('current_period_end_at'),
  firstBilledAt: tstzOptional('first_billed_at'),
  /**
   * Confirmation de la souscription payante — point de départ du délai de
   * rétractation (CDC 6 §3.1). Jamais recalculée depuis Stripe.
   */
  contractConcludedAt: tstzOptional('contract_concluded_at'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  updatedAt: tstz('updated_at'),
  createdAt: tstz('created_at'),
}, (table) => ({
  accountIdIdx: index('account_subscriptions_account_id_idx').on(table.accountId),
  planCodeIdx: index('account_subscriptions_plan_code_idx').on(table.planCode),
  statusIdx: index('account_subscriptions_status_idx').on(table.status),
  stripeCustomerIdIdx: index('account_subscriptions_stripe_customer_id_idx').on(table.stripeCustomerId),
  stripeSubscriptionIdIdx: index('account_subscriptions_stripe_subscription_id_idx').on(table.stripeSubscriptionId),
}));

/**
 * Unicite de l'essai gratuit (anti-fraude).
 * Une ligne par adresse email normalisee ; conservee meme si le compte est
 * supprime, afin qu'un meme email ne puisse pas relancer un second essai.
 */
/**
 * Evenements du parcours de souscription (CDC tarification §17).
 * Alimente les indicateurs d'activation et de conversion.
 */
export const funnelEvents = pgTable('funnel_events', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  planCode: text('plan_code'),
  billingPeriod: text('billing_period'),
  metadata: jsonb('metadata'),
  occurredAt: tstz('occurred_at'),
  createdAt: tstz('created_at'),
}, (table) => ({
  accountIdx: index('funnel_events_account_idx').on(table.accountId),
  typeIdx: index('funnel_events_type_idx').on(table.eventType),
  dateIdx: index('funnel_events_date_idx').on(table.occurredAt),
}));

export const trialGrants = pgTable('trial_grants', {
  id: serial('id').primaryKey(),
  emailNormalized: text('email_normalized').notNull(),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  grantedAt: tstz('granted_at'),
  expiresAt: tstz('expires_at'),
  convertedAt: tstzOptional('converted_at'),
  createdAt: tstz('created_at'),
}, (table) => ({
  emailIdx: uniqueIndex('trial_grants_email_uidx').on(table.emailNormalized),
  accountIdIdx: index('trial_grants_account_id_idx').on(table.accountId),
}));

export const accountAnalysisCounters = pgTable('account_analysis_counters', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  periodType: text('period_type').notNull(), // trial | annual
  periodStartAt: tstz('period_start_at'),
  periodEndAt: tstzOptional('period_end_at'),
  includedQuota: integer('included_quota').notNull(),
  includedConsumed: integer('included_consumed').notNull().default(0),
  updatedAt: tstz('updated_at'),
  createdAt: tstz('created_at'),
}, (table) => ({
  accountIdIdx: index('account_analysis_counters_account_id_idx').on(table.accountId),
  periodTypeIdx: index('account_analysis_counters_period_type_idx').on(table.periodType),
  activePeriodUniqueIdx: uniqueIndex('account_analysis_counters_active_period_uidx').on(table.accountId, table.periodType).where(sql`period_end_at IS NULL`),
}));

export const accountAnalysisCredits = pgTable('account_analysis_credits', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), // referral | pack
  packCode: text('pack_code'),
  stripeInvoiceId: text('stripe_invoice_id'),
  amountInitial: integer('amount_initial').notNull(),
  amountRemaining: integer('amount_remaining').notNull(),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('account_analysis_credits_account_id_idx').on(table.accountId),
  sourceIdx: index('account_analysis_credits_source_idx').on(table.source),
}));

export const referralLinks = pgTable('referral_links', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  code: text('code').notNull().unique(),
  createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  codeIdx: index('referral_links_code_idx').on(table.code),
  accountIdIdx: index('referral_links_account_id_idx').on(table.accountId),
}));

export const referralEvents = pgTable('referral_events', {
  id: serial('id').primaryKey(),
  referralLinkId: integer('referral_link_id').references(() => referralLinks.id, { onDelete: 'set null' }),
  referrerAccountId: integer('referrer_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  referredAccountId: integer('referred_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  referredUserId: integer('referred_user_id').references(() => users.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('link_used'), // link_used | reward_granted | canceled
  rewardCredits: integer('reward_credits').notNull().default(10),
  rewardGrantedAt: tstzOptional('reward_granted_at'),
  firstBilledAt: tstzOptional('first_billed_at'),
  /**
   * Confirmation de la souscription payante — point de départ du délai de
   * rétractation (CDC 6 §3.1). Jamais recalculée depuis Stripe.
   */
  contractConcludedAt: tstzOptional('contract_concluded_at'),
  stripeInvoiceId: text('stripe_invoice_id').unique(), // idempotence: unique par facture Stripe
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>(),
  stripeSubscriptionId: text('stripe_subscription_id'),
  signupContextId: uuid('signup_context_id'),
  capturedAt: tstzOptional('captured_at'),
  confirmedAt: tstzOptional('confirmed_at'),
  rewardedAt: tstzOptional('rewarded_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  referrerAccountIdIdx: index('referral_events_referrer_account_id_idx').on(table.referrerAccountId),
  referredAccountIdIdx: index('referral_events_referred_account_id_idx').on(table.referredAccountId),
  statusIdx: index('referral_events_status_idx').on(table.status),
}));

export const referralEmailSends = pgTable('referral_email_sends', {
  id: serial('id').primaryKey(),
  referralLinkId: integer('referral_link_id').notNull().references(() => referralLinks.id, { onDelete: 'cascade' }),
  senderAccountId: integer('sender_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  recipientEmailHash: text('recipient_email_hash').notNull(), // SHA-256 de l'email (RGPD)
  sentAt: tstz('sent_at'),
  createdAt: tstz('created_at'),
}, (table) => ({
  linkIdIdx: index('referral_email_sends_link_id_idx').on(table.referralLinkId),
  senderIdx: index('referral_email_sends_sender_idx').on(table.senderAccountId),
}));

export const promoCodes = pgTable('promo_codes', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  status: text('status').notNull().default('active'),
  campaignId: text('campaign_id'),
  validFrom: tstzOptional('valid_from'),
  validUntil: tstzOptional('valid_until'),
  targetOffer: text('target_offer'),
  stripePromotionCodeId: text('stripe_promotion_code_id'),
  maxRedemptions: integer('max_redemptions'),
  redemptionCount: integer('redemption_count').notNull().default(0),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  promoCodeIdx: index('promo_codes_code_idx').on(table.code),
  promoStatusIdx: index('promo_codes_status_idx').on(table.status),
}));

export const signupContexts = pgTable('signup_contexts', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Rattachement à l'inscrit (migration 0113). Nullable : les contextes
  // anonymes historiques n'en portent pas.
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  entryPoint: text('entry_point').notNull().default('direct_signup'),
  targetOffer: text('target_offer'),
  rawCode: text('raw_code'),
  codeSource: text('code_source'),
  resolvedCodeType: text('resolved_code_type'),
  resolvedCodeId: integer('resolved_code_id'),
  validationStatus: text('validation_status').notNull().default('pending'),
  validationMessage: text('validation_message'),
  stripePromotionCodeId: text('stripe_promotion_code_id'),
  createdAt: tstz('created_at'),
  expiresAt: tstz('expires_at'),
}, (table) => ({
  scCreatedAtIdx: index('signup_contexts_created_at_idx').on(table.createdAt),
  scUserIdx: index('signup_contexts_user_id_idx').on(table.userId),
  scAccountIdx: index('signup_contexts_account_id_idx').on(table.accountId),
}));

export const notificationEvents = pgTable('notification_events', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  periodCounterId: integer('period_counter_id').references(() => accountAnalysisCounters.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(), // analysis_quota_90 | analysis_quota_100 | referral_reward
  dedupeKey: text('dedupe_key').notNull().unique(),
  sentAt: tstz('sent_at'),
  createdAt: tstz('created_at'),
}, (table) => ({
  accountIdIdx: index('notification_events_account_id_idx').on(table.accountId),
  eventTypeIdx: index('notification_events_event_type_idx').on(table.eventType),
}));

export const aiUsageEvents = pgTable('ai_usage_events', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  feature: text('feature').notNull(), // document_analysis | ai_search
  provider: text('provider'),
  model: text('model'),
  status: text('status').notNull(), // success | failed
  estimatedCostCents: numeric('estimated_cost_cents', { precision: 10, scale: 4 }),
  fallbackReason: text('fallback_reason'),
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>(),
  createdAt: tstz('created_at'),
}, (table) => ({
  accountIdIdx: index('ai_usage_events_account_id_idx').on(table.accountId),
  featureIdx: index('ai_usage_events_feature_idx').on(table.feature),
  statusIdx: index('ai_usage_events_status_idx').on(table.status),
}));

export const dunningEvents = pgTable('dunning_events', {
  id: serial('id').primaryKey(),
  duoId: integer('duo_id').notNull().references(() => duoAccounts.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  sentAt: tstz('sent_at'),
  emailLogId: integer('email_log_id').references(() => emailLogs.id, { onDelete: 'set null' }),
}, (table) => ({
  duoIdIdx: index('dunning_events_duo_id_idx').on(table.duoId),
  duoIdStageUniqueIdx: uniqueIndex('dunning_events_duo_id_stage_unique_idx').on(table.duoId, table.stage),
}));

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: serial('id').primaryKey(),
  keyHash: text('key_hash').notNull().unique(),
  route: text('route').notNull(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  requestBodyHash: text('request_body_hash'),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  createdAt: tstz('created_at'),
  expiresAt: tstz('expires_at'),
}, (table) => ({
  keyHashIdx: index('idempotency_keys_key_hash_idx').on(table.keyHash),
  userIdIdx: index('idempotency_keys_user_id_idx').on(table.userId),
  expiresAtIdx: index('idempotency_keys_expires_at_idx').on(table.expiresAt),
}));

export const pendingBlobDeletions = pgTable('pending_blob_deletions', {
  id: serial('id').primaryKey(),
  fileId: integer('file_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  storagePath: text('storage_path').notNull(),
  scheduledFor: tstz('scheduled_for'),
  processedAt: tstzOptional('processed_at'),
  errorMessage: text('error_message'),
  createdAt: tstz('created_at'),
}, (table) => ({
  scheduledForIdx: index('pending_blob_deletions_scheduled_for_idx').on(table.scheduledFor),
  processedAtIdx: index('pending_blob_deletions_processed_at_idx').on(table.processedAt),
}));

export const assetCustomFields = pgTable('asset_custom_fields', {
  id: serial('id').primaryKey(),
  assetTypeId: integer('asset_type_id').references(() => assetTypes.id, { onDelete: 'cascade' }),
  assetTypeSubcategoryId: integer('asset_type_subcategory_id').references(() => assetTypeSubcategories.id, { onDelete: 'cascade' }),
  fieldKey: text('field_key').notNull(),
  label: text('label').notNull(),
  fieldType: text('field_type').notNull().default('text'),
  isRequired: boolean('is_required').notNull().default(false),
  displayOrder: integer('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
});

export const assetCustomFieldValues = pgTable('asset_custom_field_values', {
  id: serial('id').primaryKey(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  fieldId: integer('field_id').notNull().references(() => assetCustomFields.id, { onDelete: 'cascade' }),
  value: text('value'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  uniqueAssetField: uniqueIndex('asset_custom_field_values_asset_field_unique_idx').on(table.assetId, table.fieldId),
}));

// ─── Agenda CDC V3 ────────────────────────────────────────────────────────────

export const agendaItems = pgTable('agenda_items', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  startDate: pgDate('start_date'),
  startTime: pgTime('start_time'),
  endDate: pgDate('end_date'),
  endTime: pgTime('end_time'),
  manualStatus: text('manual_status'),
  isAutomatic: boolean('is_automatic').notNull().default(false),
  isAutomaticModified: boolean('is_automatic_modified').notNull().default(false),
  requiresQualification: boolean('requires_qualification').notNull().default(false),
  originType: text('origin_type').notNull().default('manual'),
  originRefType: text('origin_ref_type'),
  originRefId: integer('origin_ref_id'),
  originFieldKey: text('origin_field_key'),
  /** Classification pour la home : 'action' = prochaines dates / 'information' = à savoir */
  homeCategory: text('home_category'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('agenda_items_account_id_idx').on(table.accountId),
  startDateIdx: index('agenda_items_start_date_idx').on(table.startDate),
  manualStatusIdx: index('agenda_items_manual_status_idx').on(table.manualStatus),
  originTypeIdx: index('agenda_items_origin_type_idx').on(table.originType),
  homeCategoryIdx: index('agenda_items_home_category_idx').on(table.homeCategory),
  // Composite index for home summary query: accountId + startDate
  accountIdStartDateIdx: index('agenda_items_account_id_start_date_idx').on(table.accountId, table.startDate),
  manualStatusCheck: check('agenda_items_manual_status_check', sql`${table.manualStatus} IS NULL OR ${table.manualStatus} IN ('realise', 'annule')`),
  originTypeCheck: check('agenda_items_origin_type_check', sql`${table.originType} IN ('manual','asset_field','qualified_document','deduced_rule','legacy_event_migration','legacy_deadline_migration')`),
  homeCategoryCheck: check('agenda_items_home_category_check', sql`${table.homeCategory} IS NULL OR ${table.homeCategory} IN ('action', 'information')`),
}));

export const agendaAssetLinks = pgTable('agenda_asset_links', {
  id: serial('id').primaryKey(),
  agendaItemId: integer('agenda_item_id').notNull().references(() => agendaItems.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
}, (table) => ({
  agendaItemIdIdx: index('agenda_asset_links_agenda_item_id_idx').on(table.agendaItemId),
  assetIdIdx: index('agenda_asset_links_asset_id_idx').on(table.assetId),
  uniqueLink: uniqueIndex('agenda_asset_links_unique_idx').on(table.agendaItemId, table.assetId),
}));

export const agendaFileLinks = pgTable('agenda_file_links', {
  id: serial('id').primaryKey(),
  agendaItemId: integer('agenda_item_id').notNull().references(() => agendaItems.id, { onDelete: 'cascade' }),
  assetFileId: integer('asset_file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
}, (table) => ({
  agendaItemIdIdx: index('agenda_file_links_agenda_item_id_idx').on(table.agendaItemId),
  uniqueLink: uniqueIndex('agenda_file_links_unique_idx').on(table.agendaItemId, table.assetFileId),
}));

export const agendaRoomLinks = pgTable('agenda_room_links', {
  id: serial('id').primaryKey(),
  agendaItemId: integer('agenda_item_id').notNull().references(() => agendaItems.id, { onDelete: 'cascade' }),
  substructureId: integer('substructure_id').notNull().references(() => substructures.id, { onDelete: 'cascade' }),
}, (table) => ({
  agendaItemIdIdx: index('agenda_room_links_agenda_item_id_idx').on(table.agendaItemId),
  uniqueLink: uniqueIndex('agenda_room_links_unique_idx').on(table.agendaItemId, table.substructureId),
}));

export const agendaEquipmentLinks = pgTable('agenda_equipment_links', {
  id: serial('id').primaryKey(),
  agendaItemId: integer('agenda_item_id').notNull().references(() => agendaItems.id, { onDelete: 'cascade' }),
  equipmentId: integer('equipment_id').notNull().references(() => equipments.id, { onDelete: 'cascade' }),
}, (table) => ({
  agendaItemIdIdx: index('agenda_equipment_links_agenda_item_id_idx').on(table.agendaItemId),
  uniqueLink: uniqueIndex('agenda_equipment_links_unique_idx').on(table.agendaItemId, table.equipmentId),
}));

export const agendaDataConflicts = pgTable('agenda_data_conflicts', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  agendaItemId: integer('agenda_item_id').references(() => agendaItems.id, { onDelete: 'set null' }),
  resultAgendaItemId: integer('result_agenda_item_id').references(() => agendaItems.id, { onDelete: 'set null' }),
  conflictType: text('conflict_type').notNull(),
  fieldKey: text('field_key'),
  sourceTypeA: text('source_type_a').notNull(),
  sourceRefIdA: integer('source_ref_id_a'),
  valueDateA: pgDate('value_date_a'),
  sourceTypeB: text('source_type_b').notNull(),
  sourceRefIdB: integer('source_ref_id_b'),
  valueDateB: pgDate('value_date_b'),
  currentDecision: text('current_decision').notNull().default('pending'),
  requiresQualification: boolean('requires_qualification').notNull().default(false),
  note: text('note'),
  resolvedAt: tstzOptional('resolved_at'),
  resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('agenda_data_conflicts_account_id_idx').on(table.accountId),
  currentDecisionIdx: index('agenda_data_conflicts_current_decision_idx').on(table.currentDecision),
  agendaItemIdIdx: index('agenda_data_conflicts_agenda_item_id_idx').on(table.agendaItemId),
  conflictTypeCheck: check('agenda_data_conflicts_conflict_type_check', sql`${table.conflictType} IN ('date_mismatch','distinct_data_unqualified')`),
  currentDecisionCheck: check('agenda_data_conflicts_current_decision_check', sql`${table.currentDecision} IN ('pending','kept_existing','kept_new','declared_distinct','skipped')`),
}));

// ─── IA documentaire V3.3 ────────────────────────────────────────────────────

export const documentLots = pgTable('document_lots', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  label: text('label'),
  status: text('status').notNull().default('draft'),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  committedAt: pgTimestamp('committed_at', { withTimezone: true }),
}, (table) => ({
  accountIdIdx: index('document_lots_account_id_idx').on(table.accountId),
  statusIdx: index('document_lots_status_idx').on(table.status),
  statusCheck: check('document_lots_status_check', sql`${table.status} IN ('draft','uploaded','analyzing','analyzed','committing','committed','partially_failed')`),
}));

export const documentAnalysisRuns = pgTable('document_analysis_runs', {
  id: serial('id').primaryKey(),
  assetFileId: integer('asset_file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  documentVersionId: integer('document_version_id').references(() => documentVersions.id, { onDelete: 'set null' }),
  lotId: integer('lot_id').references(() => documentLots.id, { onDelete: 'set null' }),
  inputFileHash: text('input_file_hash').notNull(),
  promptVersion: text('prompt_version').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  status: text('status').notNull(),
  isCurrentReference: boolean('is_current_reference').notNull().default(false),
  startedAt: pgTimestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: pgTimestamp('finished_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  rawResponseJson: text('raw_response_json'),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  assetFileIdIdx: index('document_analysis_runs_asset_file_id_idx').on(table.assetFileId),
  accountIdIdx: index('document_analysis_runs_account_id_idx').on(table.accountId),
  statusIdx: index('document_analysis_runs_status_idx').on(table.status),
  isCurrentReferenceIdx: index('document_analysis_runs_is_current_reference_idx').on(table.isCurrentReference),
  // Unique partial index: only one current reference run per asset file
  currentReferenceUnique: uniqueIndex('document_analysis_runs_current_reference_unique_idx').on(table.assetFileId).where(sql`is_current_reference = true`),
  statusCheck: check('document_analysis_runs_status_check', sql`${table.status} IN ('pending','analyzing','completed','failed','interrupted')`),
}));

export const documentAnalysisProposals = pgTable('document_analysis_proposals', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull().references(() => documentAnalysisRuns.id, { onDelete: 'cascade' }),
  assetFileId: integer('asset_file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  proposalType: text('proposal_type').notNull(),
  targetKey: text('target_key').notNull(),
  canonicalCode: text('canonical_code'),
  displayLabel: text('display_label'),
  proposedValueJson: text('proposed_value_json').notNull(),
  confidence: text('confidence'), // stored as text to avoid float precision issues
  status: text('status').notNull().default('pending'),
  finalValueJson: text('final_value_json'),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdIdx: index('document_analysis_proposals_run_id_idx').on(table.runId),
  assetFileIdIdx: index('document_analysis_proposals_asset_file_id_idx').on(table.assetFileId),
  statusIdx: index('document_analysis_proposals_status_idx').on(table.status),
  proposalTypeCheck: check('document_analysis_proposals_proposal_type_check', sql`${table.proposalType} IN ('field','link','derived_date','agenda_suggestion')`),
  statusCheck: check('document_analysis_proposals_status_check', sql`${table.status} IN ('pending','kept','modified','rejected')`),
}));

export const documentTaxonomyMappings = pgTable('document_taxonomy_mappings', {
  id: serial('id').primaryKey(),
  mappingType: text('mapping_type').notNull(),
  rawLabel: text('raw_label').notNull(),
  canonicalCode: text('canonical_code').notNull(),
  canonicalLabel: text('canonical_label').notNull(),
  confidenceThreshold: text('confidence_threshold').notNull().default('0.75'),
  source: text('source').notNull(),
  status: text('status').notNull().default('active'),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  disabledAt: pgTimestamp('disabled_at', { withTimezone: true }),
  updatedAt: pgTimestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  mappingTypeIdx: index('document_taxonomy_mappings_mapping_type_idx').on(table.mappingType),
  statusIdx: index('document_taxonomy_mappings_status_idx').on(table.status),
  mappingTypeCheck: check('document_taxonomy_mappings_mapping_type_check', sql`${table.mappingType} IN ('function_code','date_label')`),
  sourceCheck: check('document_taxonomy_mappings_source_check', sql`${table.source} IN ('gemini','openai','manual')`),
  statusCheck: check('document_taxonomy_mappings_status_check', sql`${table.status} IN ('active','inactive')`),
}));

export const documentLotItems = pgTable('document_lot_items', {
  id: serial('id').primaryKey(),
  lotId: integer('lot_id').notNull().references(() => documentLots.id, { onDelete: 'cascade' }),
  assetFileId: integer('asset_file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  currentAnalysisRunId: integer('current_analysis_run_id').references(() => documentAnalysisRuns.id, { onDelete: 'set null' }),
  analysisStatus: text('analysis_status').notNull().default('pending'),
  commitStatus: text('commit_status').notNull().default('pending'),
  attentionProjectionJson: text('attention_projection_json'),
  confidenceSummary: text('confidence_summary'),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  lotIdIdx: index('document_lot_items_lot_id_idx').on(table.lotId),
  assetFileIdIdx: index('document_lot_items_asset_file_id_idx').on(table.assetFileId),
  uniqueLotFile: uniqueIndex('document_lot_items_lot_file_unique_idx').on(table.lotId, table.assetFileId),
  analysisStatusCheck: check('document_lot_items_analysis_status_check', sql`${table.analysisStatus} IN ('pending','analyzing','completed','failed')`),
  commitStatusCheck: check('document_lot_items_commit_status_check', sql`${table.commitStatus} IN ('pending','committed','failed')`),
}));

// ─── Exports V1 ──────────────────────────────────────────────────────────────

export const exportGenerations = pgTable('export_generation', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  exportType: text('export_type').notNull(),
  variant: text('variant'),
  status: text('status').notNull().default('pending'),
  requestedOutputs: text('requested_outputs'),
  snapshotPayload: text('snapshot_payload'),
  manifestPayload: text('manifest_payload'),
  outputPayload: text('output_payload'),
  errorPayload: text('error_payload'),
  generationStartedAt: tstzOptional('generation_started_at'),
  generationAttemptCount: integer('generation_attempt_count').notNull().default(0),
  createdAt: tstz('created_at'),
  completedAt: tstzOptional('completed_at'),
}, (table) => ({
  assetIdIdx: index('export_generation_asset_id_idx').on(table.assetId),
  accountIdIdx: index('export_generation_account_id_idx').on(table.accountId),
  statusIdx: index('export_generation_status_idx').on(table.status),
  exportTypeIdx: index('export_generation_export_type_idx').on(table.exportType),
  publicIdIdx: index('export_generation_public_id_idx').on(table.publicId),
  statusCheck: check('export_generation_status_check',
    sql`${table.status} IN ('pending','generating','ready','error','deleted','cancelled')`),
}));

export const assetTransmissions = pgTable('asset_transmissions', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  initiatorUserId: integer('initiator_user_id').notNull().references(() => users.id),
  recipientEmail: text('recipient_email').notNull(),
  recipientUserId: integer('recipient_user_id').references(() => users.id),
  token: text('token').unique().notNull(),
  // Périmètre sélectionné par l'émetteur (sélection fine)
  selectedPayload: text('selected_payload').notNull().default('{}'),
  // { includeDocuments, selectedDocIds, includeEquipments, selectedEquipmentIds,
  //   includePhotos, selectedPhotoIds, includeEvents, selectedEventIds }
  snapshotPayload: text('snapshot_payload').notNull().default('{}'),
  keepActiveAfter: boolean('keep_active_after').notNull().default(false),
  status: text('status').notNull().default('pending'),
  sentAt: tstz('sent_at'),
  acceptedAt: tstzOptional('accepted_at'),
  refusedAt: tstzOptional('refused_at'),
  cancelledAt: tstzOptional('cancelled_at'),
  // Trace interne de provenance (non exposée en UI destinataire)
  duplicatedAssetId: integer('duplicated_asset_id').references(() => assets.id),
  createdAt: tstz('created_at'),
}, (table) => ({
  assetIdIdx: index('asset_transmissions_asset_id_idx').on(table.assetId),
  tokenIdx: uniqueIndex('asset_transmissions_token_idx').on(table.token),
  statusIdx: index('asset_transmissions_status_idx').on(table.status),
  recipientIdx: index('asset_transmissions_recipient_idx').on(table.recipientEmail),
  statusCheck: check('asset_transmissions_status_check',
    sql`${table.status} IN ('pending','accepted','refused','cancelled')`),
}));

export const agendaItemSources = pgTable('agenda_item_sources', {
  id: serial('id').primaryKey(),
  agendaItemId: integer('agenda_item_id').references(() => agendaItems.id, { onDelete: 'set null' }),
  assetFileId: integer('asset_file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  runId: integer('run_id').notNull().references(() => documentAnalysisRuns.id, { onDelete: 'cascade' }),
  effectType: text('effect_type').notNull(),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  agendaItemIdIdx: index('agenda_item_sources_agenda_item_id_idx').on(table.agendaItemId),
  assetFileIdIdx: index('agenda_item_sources_asset_file_id_idx').on(table.assetFileId),
  runIdIdx: index('agenda_item_sources_run_id_idx').on(table.runId),
  effectTypeCheck: check('agenda_item_sources_effect_type_check', sql`${table.effectType} IN ('created','resolved_existing','conflict_pending','rejected_orphan')`),
}));

// ─── Fournisseurs CDC V1 ──────────────────────────────────────────────────────

export const suppliers = pgTable('suppliers', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').notNull().unique().defaultRandom(),
  accountId: integer('account_id').notNull().references(() => accounts.id),
  createdByUserId: integer('created_by_user_id').notNull().references(() => users.id),
  scope: text('scope').notNull().default('personal'),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  addressLine1: text('address_line_1'),
  addressLine2: text('address_line_2'),
  postalCode: text('postal_code'),
  city: text('city'),
  country: text('country'),
  siren: text('siren'),
  siret: text('siret'),
  vatNumber: text('vat_number'),
  iban: text('iban'),
  ibanHolderName: text('iban_holder_name'),
  source: text('source').notNull().default('manual'),
  contactStatus: text('contact_status').notNull().default('unverified'),
  status: text('status').notNull().default('active'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountNameIdx: index('idx_suppliers_account_name').on(table.accountId, table.normalizedName),
  accountStatusIdx: index('idx_suppliers_account_status').on(table.accountId, table.status),
  publicIdIdx: index('suppliers_public_id_idx').on(table.publicId),
}));

export const supplierContactObservations = pgTable('supplier_contact_observations', {
  id: serial('id').primaryKey(),
  supplierId: integer('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'cascade' }),
  documentId: integer('document_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  observedName: text('observed_name'),
  observedEmail: text('observed_email'),
  observedPhone: text('observed_phone'),
  observedWebsite: text('observed_website'),
  observedAddressLine1: text('observed_address_line_1'),
  observedAddressLine2: text('observed_address_line_2'),
  observedPostalCode: text('observed_postal_code'),
  observedCity: text('observed_city'),
  observedCountry: text('observed_country'),
  observedSiren: text('observed_siren'),
  observedSiret: text('observed_siret'),
  observedVatNumber: text('observed_vat_number'),
  observedIban: text('observed_iban'),
  observedIbanHolderName: text('observed_iban_holder_name'),
  confidenceScore: numeric('confidence_score'),
  createdAt: tstz('created_at'),
}, (table) => ({
  supplierIdIdx: index('supplier_contact_observations_supplier_id_idx').on(table.supplierId),
  documentIdIdx: index('supplier_contact_observations_document_id_idx').on(table.documentId),
}));

export const documentSuppliers = pgTable('document_suppliers', {
  documentId: integer('document_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  supplierId: integer('supplier_id').notNull().references(() => suppliers.id),
  role: text('role'),
  confidenceScore: numeric('confidence_score'),
  isConfirmed: boolean('is_confirmed').notNull().default(false),
}, (t) => ({
  pk: primaryKey({ columns: [t.documentId, t.supplierId] }),
  documentIdIdx: index('document_suppliers_document_id_idx').on(t.documentId),
  supplierIdIdx: index('document_suppliers_supplier_id_idx').on(t.supplierId),
}));

export const equipmentSuppliers = pgTable('equipment_suppliers', {
  equipmentId: integer('equipment_id').notNull().references(() => equipments.id, { onDelete: 'cascade' }),
  supplierId: integer('supplier_id').notNull().references(() => suppliers.id),
  relationshipType: text('relationship_type'),
  sourceDocumentId: integer('source_document_id').references(() => assetFiles.id),
  sourceType: text('source_type').notNull().default('manual'),
  isPrimary: boolean('is_primary').notNull().default(false),
}, (t) => ({
  pk: primaryKey({ columns: [t.equipmentId, t.supplierId] }),
  equipmentIdIdx: index('equipment_suppliers_equipment_id_idx').on(t.equipmentId),
  supplierIdIdx: index('equipment_suppliers_supplier_id_idx').on(t.supplierId),
}));

export const assetSuppliers = pgTable('asset_suppliers', {
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  supplierId: integer('supplier_id').notNull().references(() => suppliers.id),
  sourceType: text('source_type').notNull().default('derived'),
}, (t) => ({
  pk: primaryKey({ columns: [t.assetId, t.supplierId] }),
  assetIdIdx: index('asset_suppliers_asset_id_idx').on(t.assetId),
  supplierIdIdx: index('asset_suppliers_supplier_id_idx').on(t.supplierId),
}));

export const supplierReviewItems = pgTable('supplier_review_items', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').notNull().unique().defaultRandom(),
  accountId: integer('account_id').notNull().references(() => accounts.id),
  itemType: text('item_type').notNull(),
  status: text('status').notNull().default('open'),
  supplierId: integer('supplier_id').references(() => suppliers.id),
  documentId: integer('document_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  observationId: integer('observation_id').references(() => supplierContactObservations.id, { onDelete: 'set null' }),
  detectedName: text('detected_name'),
  conflictingField: text('conflicting_field'),
  currentValue: text('current_value'),
  detectedValue: text('detected_value'),
  candidateSupplierIds: jsonb('candidate_supplier_ids'),
  resolvedByUserId: integer('resolved_by_user_id').references(() => users.id),
  resolvedAt: tstzOptional('resolved_at'),
  resolution: text('resolution'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountStatusIdx: index('idx_supplier_review_items_account_status').on(table.accountId, table.status),
  supplierIdIdx: index('supplier_review_items_supplier_id_idx').on(table.supplierId),
  publicIdIdx: index('supplier_review_items_public_id_idx').on(table.publicId),
}));

// ─── CIL Réglementaire V1 ─────────────────────────────────────────────────────

export const assetCilProfiles = pgTable('asset_cil_profiles', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  assetId: integer('asset_id').notNull().unique().references(() => assets.id, { onDelete: 'cascade' }),
  triggerType: text('trigger_type').notNull().default('inconnu'),
  triggerDate: pgDate('trigger_date'),
  authorizationType: text('authorization_type'),
  voluntaryReason: text('voluntary_reason'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetIdIdx: index('asset_cil_profiles_asset_id_idx').on(table.assetId),
  triggerTypeCheck: check('asset_cil_profiles_trigger_type_check',
    sql`${table.triggerType} IN ('construction','renovation_energetique','volontaire','inconnu')`),
}));

export const energyMaterials = pgTable('energy_materials', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  materialNature: text('material_nature'),
  brand: text('brand'),
  reference: text('reference'),
  thermalResistanceR: numeric('thermal_resistance_r'),
  lambda: numeric('lambda'),
  thicknessMm: integer('thickness_mm'),
  surfaceSqm: numeric('surface_sqm'),
  interfaceTreatment: text('interface_treatment'),
  documentId: integer('document_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetIdIdx: index('energy_materials_asset_id_idx').on(table.assetId),
  categoryCheck: check('energy_materials_category_check',
    sql`${table.category} IN ('toiture','murs_exterieurs','parois_vitrees','planchers_bas')`),
}));

export const equipmentCilSpecs = pgTable('equipment_cil_specs', {
  id: serial('id').primaryKey(),
  equipmentId: integer('equipment_id').notNull().unique().references(() => equipments.id, { onDelete: 'cascade' }),
  brand: text('brand'),
  model: text('model'),
  energyType: text('energy_type'),
  evacuationMode: text('evacuation_mode'),
  serialNumber: text('serial_number'),
  powerKw: numeric('power_kw'),
  energyLabel: text('energy_label'),
  heatNetworkDeliveryStation: text('heat_network_delivery_station'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  equipmentIdIdx: index('equipment_cil_specs_equipment_id_idx').on(table.equipmentId),
}));

export const energyWorks = pgTable('energy_works', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  agendaItemId: integer('agenda_item_id').references(() => agendaItems.id, { onDelete: 'set null' }),
  category: text('category').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  completedAt: pgDate('completed_at'),
  companyName: text('company_name'),
  materialIds: text('material_ids'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetIdIdx: index('energy_works_asset_id_idx').on(table.assetId),
  categoryCheck: check('energy_works_category_check',
    sql`${table.category} IN ('isolation_toiture','isolation_murs','isolation_parois','isolation_planchers','chauffage','refroidissement','ecs','ventilation','enr')`),
}));

export const cilBlockResolutions = pgTable('cil_block_resolutions', {
  id: serial('id').primaryKey(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  blockId: text('block_id').notNull(),
  resolution: text('resolution').notNull(),
  justification: text('justification'),
  resolvedByUserId: integer('resolved_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  resolvedAt: tstz('resolved_at'),
}, (table) => ({
  assetBlockIdx: uniqueIndex('cil_block_resolutions_asset_block_idx').on(table.assetId, table.blockId),
  assetIdIdx: index('cil_block_resolutions_asset_id_idx').on(table.assetId),
  resolutionCheck: check('cil_block_resolutions_resolution_check',
    sql`${table.resolution} IN ('not_applicable','unknown_confirmed')`),
}));

export const documentCilMetadata = pgTable('document_cil_metadata', {
  id: serial('id').primaryKey(),
  assetFileId: integer('asset_file_id').notNull().unique().references(() => assetFiles.id, { onDelete: 'cascade' }),
  planState: text('plan_state'),
  cilCategory: text('cil_category'),
  includeInAnnex: boolean('include_in_annex').notNull().default(true),
  sortOrder: integer('sort_order'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  assetFileIdIdx: index('document_cil_metadata_asset_file_id_idx').on(table.assetFileId),
  planStateCheck: check('document_cil_metadata_plan_state_check',
    sql`${table.planState} IS NULL OR ${table.planState} IN ('conception','execution')`),
}));

// ── AI Instructions (admin-written instructions to tune AI prompts) ──────────
export const aiInstructions = pgTable('ai_instructions', {
  id: serial('id').primaryKey(),
  instruction: text('instruction').notNull(),
  status: text('status').notNull().default('pending'), // pending | applied | dismissed
  geminiAnalysis: text('gemini_analysis'),             // Gemini's interpretation
  promptsPatched: text('prompts_patched'),             // JSON array of patched prompt names
  createdAt: tstz('created_at'),
  appliedAt: pgTimestamp('applied_at', { withTimezone: true }),
  createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

// ──────────────────────────────────────────────────────────────────────────────
// SUIVI CONSOMMATION IA — CDC Verebona V2 (migration 0067)
// ──────────────────────────────────────────────────────────────────────────────

// 1. Compteurs agrégés par compte
export const aiUsageAccountCounter = pgTable('ai_usage_account_counter', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  periodYear: integer('period_year').notNull(),
  documentsAnalyzedCount: integer('documents_analyzed_count').notNull().default(0),
  documentsAnalyzedQuota: integer('documents_analyzed_quota').notNull().default(0),
  trialDocumentsCount: integer('trial_documents_count').notNull().default(0),
  trialDocumentsQuota: integer('trial_documents_quota').notNull().default(0),
  lastResetAt: tstzOptional('last_reset_at'),
  resetByAdminId: integer('reset_by_admin_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('ai_usage_account_counter_account_id_idx').on(table.accountId),
  periodYearIdx: index('ai_usage_account_counter_period_year_idx').on(table.periodYear),
  uniqueAccountYear: unique('ai_usage_account_counter_account_year_unique').on(table.accountId, table.periodYear),
}));

// 2. Événement de consommation IA
export const aiUsageEvent = pgTable('ai_usage_event', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  assetFileId: integer('asset_file_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  operationType: text('operation_type').notNull(),
  // Rattachement aux cinq usages (migration 0101). La colonne existait en base
  // mais n'était pas déclarée ici : Drizzle ne pouvait donc pas l'écrire, et
  // tout événement produit après la 0110 repartait non rattaché.
  useCaseCode: text('use_case_code'),
  provider: text('provider'),
  model: text('model'),
  isBillable: boolean('is_billable').notNull().default(true),
  isFallback: boolean('is_fallback').notNull().default(false),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costMicros: integer('cost_micros'),
  durationMs: integer('duration_ms'),
  environment: text('environment').notNull().default('production'),
  pipelineVersion: text('pipeline_version'),
  status: text('status').notNull().default('success'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: tstz('created_at'),
}, (table) => ({
  accountIdIdx: index('ai_usage_event_account_id_idx').on(table.accountId),
  assetFileIdIdx: index('ai_usage_event_asset_file_id_idx').on(table.assetFileId),
  operationTypeIdx: index('ai_usage_event_operation_type_idx').on(table.operationType),
  providerIdx: index('ai_usage_event_provider_idx').on(table.provider),
  createdAtIdx: index('ai_usage_event_created_at_idx').on(table.createdAt),
  statusIdx: index('ai_usage_event_status_idx').on(table.status),
}));

// 3. Opération IA métier
export const aiOperation = pgTable('ai_operation', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  assetFileId: integer('asset_file_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  operationCategory: text('operation_category').notNull(),
  pipelineVersion: text('pipeline_version'),
  startedAt: tstz('started_at'),
  completedAt: tstzOptional('completed_at'),
  durationMs: integer('duration_ms'),
  businessResult: text('business_result').notNull().default('pending'),
  totalCostMicros: integer('total_cost_micros').notNull().default(0),
  totalInputTokens: integer('total_input_tokens').notNull().default(0),
  totalOutputTokens: integer('total_output_tokens').notNull().default(0),
  stepsCount: integer('steps_count').notNull().default(0),
  providerPrimary: text('provider_primary'),
  providerFallback: text('provider_fallback'),
  usedFallback: boolean('used_fallback').notNull().default(false),
  isReanalysis: boolean('is_reanalysis').notNull().default(false),
  reanalysisReason: text('reanalysis_reason'),
  origin: text('origin').notNull().default('upload'),
  isBillable: boolean('is_billable').notNull().default(true),
  environment: text('environment').notNull().default('production'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  warningMessage: text('warning_message'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountIdIdx: index('ai_operation_account_id_idx').on(table.accountId),
  assetFileIdIdx: index('ai_operation_asset_file_id_idx').on(table.assetFileId),
  businessResultIdx: index('ai_operation_business_result_idx').on(table.businessResult),
  operationCategoryIdx: index('ai_operation_operation_category_idx').on(table.operationCategory),
  startedAtIdx: index('ai_operation_started_at_idx').on(table.startedAt),
  environmentIdx: index('ai_operation_environment_idx').on(table.environment),
  originIdx: index('ai_operation_origin_idx').on(table.origin),
}));

// 4. Étape technique de pipeline
export const aiPipelineStep = pgTable('ai_pipeline_step', {
  id: serial('id').primaryKey(),
  operationId: integer('operation_id').notNull().references(() => aiOperation.id, { onDelete: 'cascade' }),
  stepName: text('step_name').notNull(),
  stepOrder: integer('step_order').notNull().default(0),
  provider: text('provider'),
  model: text('model'),
  startedAt: tstz('started_at'),
  completedAt: tstzOptional('completed_at'),
  durationMs: integer('duration_ms'),
  status: text('status').notNull().default('pending'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costMicros: integer('cost_micros'),
  isFallback: boolean('is_fallback').notNull().default(false),
  fallbackReason: text('fallback_reason'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  promptVersion: text('prompt_version'),
  inputHash: text('input_hash'),
  outputPreview: text('output_preview'),
  createdAt: tstz('created_at'),
}, (table) => ({
  operationIdIdx: index('ai_pipeline_step_operation_id_idx').on(table.operationId),
  stepNameIdx: index('ai_pipeline_step_step_name_idx').on(table.stepName),
  statusIdx: index('ai_pipeline_step_status_idx').on(table.status),
  providerIdx: index('ai_pipeline_step_provider_idx').on(table.provider),
}));

// 5. Version d'analyse d'un document
export const aiAnalysisVersion = pgTable('ai_analysis_version', {
  id: serial('id').primaryKey(),
  assetFileId: integer('asset_file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  operationId: integer('operation_id').references(() => aiOperation.id, { onDelete: 'set null' }),
  versionNumber: integer('version_number').notNull().default(1),
  analysisDate: tstz('analysis_date'),
  pipelineVersion: text('pipeline_version'),
  businessResult: text('business_result').notNull().default('success'),
  totalCostMicros: integer('total_cost_micros').notNull().default(0),
  providerUsed: text('provider_used'),
  usedFallback: boolean('used_fallback').notNull().default(false),
  isCurrent: boolean('is_current').notNull().default(true),
  createdAt: tstz('created_at'),
}, (table) => ({
  assetFileIdIdx: index('ai_analysis_version_asset_file_id_idx').on(table.assetFileId),
  operationIdIdx: index('ai_analysis_version_operation_id_idx').on(table.operationId),
  isCurrentIdx: index('ai_analysis_version_is_current_idx').on(table.isCurrent),
}));

// 6. Version de pipeline (configuration routage multi-provider)
export const aiPipelineVersion = pgTable('ai_pipeline_version', {
  id: serial('id').primaryKey(),
  versionCode: text('version_code').notNull().unique(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  routingConfig: jsonb('routing_config').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
}, (table) => ({
  isActiveIdx: index('ai_pipeline_version_is_active_idx').on(table.isActive),
}));

// 7. Blocage sécurité IA
export const aiSecurityLock = pgTable('ai_security_lock', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  assetFileId: integer('asset_file_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  lockType: text('lock_type').notNull(),
  triggeredAt: tstz('triggered_at'),
  triggerDetails: text('trigger_details'),
  isResolved: boolean('is_resolved').notNull().default(false),
  resolvedAt: tstzOptional('resolved_at'),
  resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  resolutionNotes: text('resolution_notes'),
  autoResolved: boolean('auto_resolved').notNull().default(false),
  createdAt: tstz('created_at'),
}, (table) => ({
  accountIdIdx: index('ai_security_lock_account_id_idx').on(table.accountId),
  isResolvedIdx: index('ai_security_lock_is_resolved_idx').on(table.isResolved),
  lockTypeIdx: index('ai_security_lock_lock_type_idx').on(table.lockType),
  triggeredAtIdx: index('ai_security_lock_triggered_at_idx').on(table.triggeredAt),
}));

// 8. Journal d'audit admin IA
export const aiAdminAuditLog = pgTable('ai_admin_audit_log', {
  id: serial('id').primaryKey(),
  adminUserId: integer('admin_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  adminEmail: text('admin_email').notNull(),
  actionType: text('action_type').notNull(),
  targetAccountId: integer('target_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  targetFileId: integer('target_file_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  targetLockId: integer('target_lock_id').references(() => aiSecurityLock.id, { onDelete: 'set null' }),
  beforeValue: jsonb('before_value').$type<Record<string, unknown>>(),
  afterValue: jsonb('after_value').$type<Record<string, unknown>>(),
  reason: text('reason'),
  ipAddress: text('ip_address'),
  createdAt: tstz('created_at'),
}, (table) => ({
  adminUserIdIdx: index('ai_admin_audit_log_admin_user_id_idx').on(table.adminUserId),
  actionTypeIdx: index('ai_admin_audit_log_action_type_idx').on(table.actionType),
  targetAccountIdIdx: index('ai_admin_audit_log_target_account_id_idx').on(table.targetAccountId),
  createdAtIdx: index('ai_admin_audit_log_created_at_idx').on(table.createdAt),
}));

// 9. Log des recherches intelligentes (CDC Verebona — Recherche Intelligente V1)
export const aiSearchLog = pgTable('ai_search_log', {
  id: serial('id').primaryKey(),
  publicId: uuid('public_id').defaultRandom().unique().notNull(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Texte brut de la requête (conservé 12 mois — RGPD §24) */
  queryText: text('query_text').notNull(),
  /** Mode de réponse retourné : answer | sources_only | upgrade_hint | blocked_offer | blocked_ambiguous | no_result */
  responseMode: text('response_mode').notNull().default('no_result'),
  /** Texte de réponse générée (null si blocked ou no_result) */
  answerText: text('answer_text'),
  /** Nombre de sources retournées */
  sourcesCount: integer('sources_count').notNull().default(0),
  /** Offre du compte au moment de la requête */
  offerCode: text('offer_code').notNull(),
  /** Contexte transmis par le front (ex: asset, document…) */
  contextType: text('context_type'),
  contextId: integer('context_id'),
  /** Coût LLM en micro-euros */
  costMicros: integer('cost_micros').notNull().default(0),
  /** Tokens consommés */
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  /** Durée du traitement en ms */
  durationMs: integer('duration_ms'),
  /** Provider LLM utilisé */
  provider: text('provider'),
  model: text('model'),
  /** Résultat métier */
  businessResult: text('business_result').notNull().default('success'),
  /** Raison de blocage si applicable */
  blockReason: text('block_reason'),
  /** ID de tracking pour le front */
  trackingId: uuid('tracking_id').defaultRandom().notNull(),
  /** Environnement */
  environment: text('environment').notNull().default('production'),
  createdAt: tstz('created_at'),
}, (table) => ({
  accountIdIdx: index('ai_search_log_account_id_idx').on(table.accountId),
  userIdIdx: index('ai_search_log_user_id_idx').on(table.userId),
  createdAtIdx: index('ai_search_log_created_at_idx').on(table.createdAt),
  responseModeIdx: index('ai_search_log_response_mode_idx').on(table.responseMode),
  offerCodeIdx: index('ai_search_log_offer_code_idx').on(table.offerCode),
  businessResultIdx: index('ai_search_log_business_result_idx').on(table.businessResult),
}));

// ── Historique des modifications automatiques IA ─────────────────────────────
export const aiFieldUpdates = pgTable('ai_field_updates', {
  id:          serial('id').primaryKey(),
  accountId:   integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  assetId:     integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  assetFileId: integer('asset_file_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  fieldKey:    text('field_key').notNull(),
  oldValue:    text('old_value'),
  newValue:    text('new_value').notNull(),
  createdAt:   pgTimestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Impact Propagation Engine V1 ───────────────────────────────────────────
// Tables for event-driven impact propagation (replaces heavy nightly AI batch).

export const impactQueue = pgTable('impact_queue', {
  id:            serial('id').primaryKey(),
  publicId:      uuid('public_id').defaultRandom().unique().notNull(),
  accountId:     integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  assetId:       integer('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
  documentId:    integer('document_id').references(() => assetFiles.id, { onDelete: 'set null' }),
  agendaItemId:  integer('agenda_item_id').references(() => agendaItems.id, { onDelete: 'set null' }),
  triggerType:   text('trigger_type').notNull(),
  triggerReason: text('trigger_reason'),
  source:        text('source').notNull(),
  status:        text('status').notNull().default('pending'),
  priority:      integer('priority').notNull().default(0),
  attempts:      integer('attempts').notNull().default(0),
  maxAttempts:   integer('max_attempts').notNull().default(3),
  lastError:     text('last_error'),
  metadata:      jsonb('metadata').notNull().default({}),
  scheduledFor:  tstzOptional('scheduled_for'),
  lockedUntil:   tstzOptional('locked_until'),
  completedAt:   tstzOptional('completed_at'),
  createdAt:     tstz('created_at'),
  updatedAt:     tstz('updated_at'),
}, (table) => ({
  accountIdIdx:          index('impact_queue_account_id_idx').on(table.accountId),
  statusIdx:             index('impact_queue_status_idx').on(table.status),
  triggerTypeIdx:        index('impact_queue_trigger_type_idx').on(table.triggerType),
  priorityScheduledIdx:  index('impact_queue_priority_scheduled_idx').on(table.priority, table.scheduledFor),
  lockedUntilIdx:        index('impact_queue_locked_until_idx').on(table.lockedUntil),
}));

export const fieldDependencies = pgTable('field_dependencies', {
  id:            serial('id').primaryKey(),
  sourceField:   text('source_field').notNull(),
  targetField:   text('target_field').notNull(),
  category:      text('category'),
  impactType:    text('impact_type').notNull().default('propagation'),
  transformRule: text('transform_rule'),
  confidence:    text('confidence').notNull().default('certain'),
  isActive:      boolean('is_active').notNull().default(true),
  createdAt:     tstz('created_at'),
  updatedAt:     tstz('updated_at'),
}, (table) => ({
  sourceTargetIdx:      uniqueIndex('field_dependencies_source_target_idx').on(table.sourceField, table.targetField, table.category),
  impactTypeIdx:        index('field_dependencies_impact_type_idx').on(table.impactType),
  confidenceIdx:        index('field_dependencies_confidence_idx').on(table.confidence),
}));

export const inconsistencyRegistry = pgTable('inconsistency_registry', {
  id:                serial('id').primaryKey(),
  publicId:          uuid('public_id').defaultRandom().unique().notNull(),
  accountId:         integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  assetId:           integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  fieldKey:          text('field_key').notNull(),
  currentValue:      text('current_value'),
  proposedValue:     text('proposed_value'),
  sourceType:        text('source_type').notNull(),
  sourceDetail:      text('source_detail'),
  inconsistencyType: text('inconsistency_type').notNull().default('probable'),
  status:            text('status').notNull().default('open'),
  resolution:        text('resolution'),
  resolvedAt:        tstzOptional('resolved_at'),
  resolvedBy:        integer('resolved_by'),
  createdAt:         tstz('created_at'),
  updatedAt:         tstz('updated_at'),
}, (table) => ({
  accountIdIdx:               index('inconsistency_registry_account_id_idx').on(table.accountId),
  assetIdIdx:                 index('inconsistency_registry_asset_id_idx').on(table.assetId),
  statusIdx:                  index('inconsistency_registry_status_idx').on(table.status),
  typeStatusIdx:              index('inconsistency_registry_type_status_idx').on(table.inconsistencyType, table.status),
    assetFieldOpenUnique:       uniqueIndex('inconsistency_registry_asset_field_open_idx').on(table.assetId, table.fieldKey).where(sql`status = 'open'`),
}));

export const objectVersions = pgTable('object_versions', {
  id:               serial('id').primaryKey(),
  objectType:       text('object_type').notNull(),
  objectId:         integer('object_id').notNull(),
  accountId:        integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contentHash:      text('content_hash').notNull(),
  version:          integer('version').notNull().default(1),
  lastVerifiedAt:   tstzOptional('last_verified_at'),
  lastChangedAt:    tstz('last_changed_at'),
  metadata:         jsonb('metadata').notNull().default({}),
  createdAt:        tstz('created_at'),
  updatedAt:        tstz('updated_at'),
}, (table) => ({
  typeObjectAccountUnique:  uniqueIndex('object_versions_type_id_idx').on(table.objectType, table.objectId, table.accountId),
  accountIdIdx:             index('object_versions_account_id_idx').on(table.accountId),
  contentHashIdx:           index('object_versions_content_hash_idx').on(table.contentHash),
  lastVerifiedIdx:          index('object_versions_last_verified_idx').on(table.lastVerifiedAt),
}));

// ═══════════════════════════════════════════════════════════════════════════
// LOT 1 — Socle multicanal de notifications (cf. CDC §12)
// Séparation événement / livraison : un événement métier (outbox) donne lieu
// à une ou plusieurs livraisons (deliveries), une par canal et, pour le push,
// par appareil. Les préférences sont TOUJOURS au niveau user_id, jamais compte.
// ═══════════════════════════════════════════════════════════════════════════

// §12.1 — Préférences par utilisateur. Une ligne n'est créée que lorsqu'un
// utilisateur modifie un réglage ; les valeurs par défaut sont calculées dans
// le catalogue central. L'API renvoie toujours la matrice complète fusionnée.
export const notificationPreferences = pgTable('notification_preferences', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  deliveryMode: text('delivery_mode').notNull().default('immediate'), // immediate | daily_digest
  channel: text('channel').notNull(), // push | email  (la cloche n'est pas configurable en V1)
  enabled: boolean('enabled').notNull(),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  userChannelUnique: unique('notification_preferences_unique').on(
    table.userId, table.category, table.deliveryMode, table.channel,
  ),
  userIdIdx: index('notification_preferences_user_id_idx').on(table.userId),
  deliveryModeCheck: check('notification_preferences_delivery_mode_check',
    sql`${table.deliveryMode} IN ('immediate','daily_digest')`),
  channelCheck: check('notification_preferences_channel_check',
    sql`${table.channel} IN ('push','email')`),
}));

// §12.2 — Abonnements Web Push, un par appareil. endpoint + clés = données
// sensibles de capacité : jamais en clair dans les logs, chiffrement applicatif
// au repos recommandé (à brancher au Lot 2 via un wrapper crypto).
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dhKey: text('p256dh_key').notNull(),
  authKey: text('auth_key').notNull(),
  userAgent: text('user_agent'), // minimisé
  platform: text('platform'),
  deviceLabel: text('device_label'),
  status: text('status').notNull().default('active'), // active | revoked | expired | failed
  failureCount: integer('failure_count').notNull().default(0),
  lastSuccessAt: tstzOptional('last_success_at'),
  lastFailureAt: tstzOptional('last_failure_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  userIdIdx: index('push_subscriptions_user_id_idx').on(table.userId),
  statusIdx: index('push_subscriptions_status_idx').on(table.status),
  statusCheck: check('push_subscriptions_status_check',
    sql`${table.status} IN ('active','revoked','expired','failed')`),
}));

// §12.3 — File persistante des événements métier à traiter. Une source unique :
// aucun service ne doit plus insérer directement une notification pour un
// événement couvert par le CDC. dedupe_key garantit qu'une relance technique ne
// crée jamais un second fait utilisateur (cf. §4.4).
export const notificationOutbox = pgTable('notification_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: text('event_type').notNull(),
  category: text('category'),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  recipientUserId: integer('recipient_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  payloadJson: jsonb('payload_json'),
  deepLink: text('deep_link'),
  priority: text('priority').notNull().default('normal'), // low | normal | high
  mandatoryBell: boolean('mandatory_bell').notNull().default(false),
  mandatoryEmail: boolean('mandatory_email').notNull().default(false),
  dedupeKey: text('dedupe_key').notNull().unique(),
  scheduledFor: tstzOptional('scheduled_for'),
  status: text('status').notNull().default('pending'), // pending | processing | sent | partial | failed | cancelled
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt: tstz('created_at'),
  processedAt: tstzOptional('processed_at'),
}, (table) => ({
  recipientIdx: index('notification_outbox_recipient_idx').on(table.recipientUserId),
  // Index de scrutation du dispatcher : événements dus et non terminés.
  dueIdx: index('notification_outbox_due_idx').on(table.status, table.scheduledFor),
  priorityCheck: check('notification_outbox_priority_check',
    sql`${table.priority} IN ('low','normal','high')`),
  statusCheck: check('notification_outbox_status_check',
    sql`${table.status} IN ('pending','processing','sent','partial','failed','cancelled')`),
}));

// §12.4 — Journal de livraison multicanal. Une ligne par canal et, pour le
// push, par appareil : permet de distinguer un échec partiel d'un échec global
// et de savoir si une livraison a été envoyée, ignorée par préférence, rejetée,
// expirée ou retentée.
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  outboxId: uuid('outbox_id').notNull().references(() => notificationOutbox.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(), // bell | push | email
  pushSubscriptionId: uuid('push_subscription_id').references(() => pushSubscriptions.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'), // pending | sent | failed | skipped_preference | skipped_unavailable | expired
  providerMessageId: text('provider_message_id'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'), // minimisé
  attemptedAt: tstzOptional('attempted_at'),
  sentAt: tstzOptional('sent_at'),
  createdAt: tstz('created_at'),
}, (table) => ({
  outboxIdIdx: index('notification_deliveries_outbox_id_idx').on(table.outboxId),
  channelStatusIdx: index('notification_deliveries_channel_status_idx').on(table.channel, table.status),
  channelCheck: check('notification_deliveries_channel_check',
    sql`${table.channel} IN ('bell','push','email')`),
  statusCheck: check('notification_deliveries_status_check',
    sql`${table.status} IN ('pending','sent','failed','skipped_preference','skipped_unavailable','expired')`),
}));

// §7.3 / §12.6 — État persistant de la vue « À traiter » (Lot 4). Détecte les
// entrées/sorties de la vue calculée pour notifier une fois par cycle actif.
export const toProcessItemState = pgTable('to_process_item_state', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  itemKey: text('item_key').notNull(),
  problemKey: text('problem_key'),
  firstSeenAt: tstz('first_seen_at'),
  lastSeenAt: tstz('last_seen_at'),
  activeSince: tstzOptional('active_since'),
  resolvedAt: tstzOptional('resolved_at'),
  cycleNumber: integer('cycle_number').notNull().default(1),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  accountItemUnique: unique('to_process_item_state_unique').on(table.accountId, table.itemKey),
  accountIdx: index('to_process_item_state_account_idx').on(table.accountId),
  activeIdx: index('to_process_item_state_active_idx').on(table.accountId, table.isActive),
}));

// §7.8 / §19.5 — Consentement aux actualités (Lot 5+). Jamais activé par
// défaut ni déduit de l'autorisation push ; retrait immédiat ; preuve conservée.
export const newsConsents = pgTable('news_consents', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  consented: boolean('consented').notNull().default(false),
  source: text('source'),
  version: text('version'),
  consentedAt: tstzOptional('consented_at'),
  revokedAt: tstzOptional('revoked_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  userUnique: unique('news_consents_user_unique').on(table.userId),
  userIdx: index('news_consents_user_idx').on(table.userId),
  consentedIdx: index('news_consents_consented_idx').on(table.consented),
}));

export * from './verebona-schema';
// Tables du socle IA (CDC §5.1, §5.4, §5.7) — migrations 0101 à 0111.
//
// ⚠️ Cette ligne manquait. Les tables existaient en base par les migrations,
// mais `drizzle-kit` ne les voyait pas : ni `db:studio`, ni `db:generate`, ni
// la vérification de dérive du schéma. `field-evidence.service.ts` importait
// directement `@/db/ai-schema`, court-circuitant le schéma principal.
export * from './ai-schema';

// ═══════════════════════════════════════════════════════════════════════════
// CGVU — versionnement, acceptation, audit (CDC 7, migration 0115)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Une version de CGVU. Figée à la publication par un déclencheur PostgreSQL :
 * aucune écriture applicative ne peut la modifier, y compris par erreur.
 */
export const legalDocumentVersions = pgTable('legal_document_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentType: text('document_type').notNull().default('CGVU'),
  /** Format `AAAA-MM-JJ-vN` (§7). Unique par type, jamais réutilisé. */
  versionCode: text('version_code').notNull(),
  title: text('title').notNull(),
  /** DRAFT | PUBLISHED | CURRENT | ARCHIVED (§6.1). */
  status: text('status').notNull().default('DRAFT'),
  effectiveAt: tstzOptional('effective_at'),
  publishedAt: tstzOptional('published_at'),
  publishedBy: integer('published_by').references(() => users.id, { onDelete: 'set null' }),
  changeSummary: text('change_summary').notNull(),
  /** Qualification du §17, décidée avant publication. */
  requiresReacceptance: boolean('requires_reacceptance').notNull().default(false),
  /** HTML autonome figé. Fait foi (cf. en-tête de la migration 0115). */
  htmlContent: text('html_content'),
  htmlStorageKey: text('html_storage_key'),
  permalink: text('permalink'),
  sha256: text('sha256'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  lvCodeIdx: index('legal_versions_code_idx').on(table.documentType, table.versionCode),
  lvStatusIdx: index('legal_versions_status_idx').on(table.status),
}));

/**
 * Preuve d'acceptation. Non modifiable après création (§9) : une correction
 * passe par un nouvel événement, jamais par une mise à jour.
 */
export const legalAcceptances = pgTable('legal_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Nullable : la preuve survit à la suppression du compte, pseudonymisée. */
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  legalDocumentVersionId: uuid('legal_document_version_id')
    .notNull()
    .references(() => legalDocumentVersions.id),
  acceptedAt: tstz('accepted_at'),
  /** ACCOUNT_CREATION | TRIAL_START | PAID_SUBSCRIPTION | VERSION_UPDATE. */
  acceptanceContext: text('acceptance_context').notNull(),
  subscriptionId: integer('subscription_id')
    .references(() => accountSubscriptions.id, { onDelete: 'set null' }),
  offerCode: text('offer_code'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: tstz('created_at'),
}, (table) => ({
  laUserIdx: index('legal_acceptances_user_idx2').on(table.userId),
  laVersionIdx: index('legal_acceptances_version_idx2').on(table.legalDocumentVersionId),
}));

/** Journal des opérations sur les documents légaux (§19). */
export const legalAuditLog = pgTable('legal_audit_log', {
  id: serial('id').primaryKey(),
  occurredAt: tstz('occurred_at'),
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorLabel: text('actor_label').notNull().default('system'),
  action: text('action').notNull(),
  versionCode: text('version_code'),
  versionId: uuid('version_id'),
  result: text('result').notNull().default('success'),
  details: text('details'),
}, (table) => ({
  lalOccurredIdx: index('legal_audit_occurred_idx2').on(table.occurredAt),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Suppression planifiée de compte (CDC rétractation §13.3, migration 0116)
// ═══════════════════════════════════════════════════════════════════════════

export const scheduledAccountDeletions = pgTable('scheduled_account_deletions', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** WITHDRAWAL | VOLUNTARY | TRIAL_ABANDONED. */
  reason: text('reason').notNull(),
  confirmedAt: tstz('confirmed_at'),
  /** `confirmedAt` + 30 jours, figé à l'écriture. */
  scheduledAt: tstz('scheduled_at'),
  /** SCHEDULED | CANCELLED | EXECUTED | FAILED. */
  status: text('status').notNull().default('SCHEDULED'),
  cancelledAt: tstzOptional('cancelled_at'),
  cancellationReason: text('cancellation_reason'),
  executedAt: tstzOptional('executed_at'),
  failureReason: text('failure_reason'),
  reminderJ7SentAt: tstzOptional('reminder_j7_sent_at'),
  reminderJ1SentAt: tstzOptional('reminder_j1_sent_at'),
  initialEmailSentAt: tstzOptional('initial_email_sent_at'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  sadAccountIdx: index('scheduled_deletions_account_idx').on(table.accountId),
  sadScheduledIdx: index('scheduled_deletions_scheduled_idx').on(table.scheduledAt),
  sadUserIdx: index('scheduled_deletions_user_idx2').on(table.userId),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Rétractation (CDC 6 §11, migration 0117)
// ═══════════════════════════════════════════════════════════════════════════

export const withdrawalRequests = pgTable('withdrawal_requests', {
  id: serial('id').primaryKey(),
  /** Référence communiquée au consommateur : `RET-AAAAMMJJ-XXXXXX`. */
  publicReference: text('public_reference').notNull().unique(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  subscriptionIdInternal: integer('subscription_id_internal')
    .references(() => accountSubscriptions.id, { onDelete: 'set null' }),
  stripeSubscriptionId: text('stripe_subscription_id'),
  /** Date de référence du §3.1. Jamais recalculée depuis Stripe. */
  contractConcludedAt: tstzOptional('contract_concluded_at'),
  withdrawalDeadlineAt: tstzOptional('withdrawal_deadline_at'),
  requestedAt: tstz('requested_at'),
  confirmedAt: tstzOptional('confirmed_at'),
  effectiveAt: tstzOptional('effective_at'),
  /** authenticated | public | email | postal | support. */
  channel: text('channel').notNull().default('authenticated'),
  /** received | manual_review | processing | completed | failed | rejected. */
  status: text('status').notNull().default('received'),
  consumerFirstName: text('consumer_first_name'),
  consumerLastName: text('consumer_last_name'),
  receiptEmail: text('receipt_email'),
  /** Ce qui a été affiché et confirmé. Figé (§11). */
  declarationSnapshotJson: text('declaration_snapshot_json'),
  contractSnapshotJson: text('contract_snapshot_json'),
  /** En centimes. */
  amountExpected: integer('amount_expected'),
  amountRefunded: integer('amount_refunded').notNull().default(0),
  currency: text('currency').notNull().default('eur'),
  stripeRefundIds: text('stripe_refund_ids'),
  stripeRefundStatuses: text('stripe_refund_statuses'),
  cancellationStatus: text('cancellation_status').notNull().default('pending'),
  failureCode: text('failure_code'),
  failureDetails: text('failure_details'),
  receiptSentAt: tstzOptional('receipt_sent_at'),
  dataExportDeadlineAt: tstzOptional('data_export_deadline_at'),
  dataDeletionScheduledAt: tstzOptional('data_deletion_scheduled_at'),
  idempotencyKey: text('idempotency_key'),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  wrUserIdx: index('withdrawal_user_idx2').on(table.userId),
  wrAccountIdx: index('withdrawal_account_idx2').on(table.accountId),
  wrStatusIdx: index('withdrawal_status_idx2').on(table.status),
}));

/** Vérification d'adresse du parcours public. Empreinte seule, jamais le jeton. */
export const withdrawalVerificationTokens = pgTable('withdrawal_verification_tokens', {
  id: serial('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  email: text('email').notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  firstName: text('first_name'),
  lastName: text('last_name'),
  contractReference: text('contract_reference'),
  expiresAt: tstz('expires_at'),
  consumedAt: tstzOptional('consumed_at'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: tstz('created_at'),
}, (table) => ({
  wvtEmailIdx: index('withdrawal_tokens_email_idx2').on(table.email),
}));

/**
 * Journal en ajout seul des rétractations (CDC 6 §18, migration 0118).
 *
 * Les colonnes de `withdrawalRequests` portent l'état courant et sont
 * écrasées ; ce journal porte l'histoire et ne l'est jamais.
 */
export const withdrawalEvents = pgTable('withdrawal_events', {
  id: serial('id').primaryKey(),
  withdrawalId: integer('withdrawal_id')
    .notNull()
    .references(() => withdrawalRequests.id, { onDelete: 'cascade' }),
  publicReference: text('public_reference').notNull(),
  occurredAt: tstz('occurred_at'),
  eventType: text('event_type').notNull(),
  /** `consumer` | `system` | `stripe` | `admin:<id>`. */
  actor: text('actor').notNull().default('system'),
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  result: text('result').notNull().default('success'),
  summary: text('summary').notNull(),
  payloadJson: text('payload_json'),
}, (table) => ({
  weRequestIdx: index('withdrawal_events_request_idx2').on(table.withdrawalId),
  weReferenceIdx: index('withdrawal_events_reference_idx2').on(table.publicReference),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Référentiel de catégories documentaires (CDC 5 §8, migration 0119)
// ═══════════════════════════════════════════════════════════════════════════

export const documentCategories = pgTable('document_categories', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  genericLabel: text('generic_label').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  /** AUTRES_DOCUMENTS est obligatoire et non désactivable (§6.1). */
  isSystemRequired: boolean('is_system_required').notNull().default(false),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: tstz('created_at'),
  updatedAt: tstz('updated_at'),
}, (table) => ({
  dcCodeIdx: index('document_categories_code_idx').on(table.code),
  dcActiveIdx: index('document_categories_active_idx').on(table.isActive),
}));

/** Applicabilité par famille de bien et libellés contextualisés (§3.3). */
export const documentCategoryAssetAssociations = pgTable('document_category_asset_associations', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id').notNull()
    .references(() => documentCategories.id, { onDelete: 'cascade' }),
  /** `null` = applicable à toutes les familles. */
  assetTypeId: integer('asset_type_id').references(() => assetTypes.id, { onDelete: 'cascade' }),
  assetSubcategoryCode: text('asset_subcategory_code'),
  contextualLabel: text('contextual_label'),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: tstz('created_at'),
}, (table) => ({
  dcaaCategoryIdx: index('document_category_asset_category_idx').on(table.categoryId),
}));

/** Compatibilité type ↔ catégorie (§4.3). */
export const documentCategoryTypeAssociations = pgTable('document_category_type_associations', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id').notNull()
    .references(() => documentCategories.id, { onDelete: 'cascade' }),
  documentTypeId: integer('document_type_id').notNull()
    .references(() => documentTypes.id, { onDelete: 'cascade' }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: tstz('created_at'),
}, (table) => ({
  dctaCategoryIdx: index('document_category_type_category_idx').on(table.categoryId),
  dctaTypeIdx: index('document_category_type_type_idx2').on(table.documentTypeId),
}));

/** Signal d'échec de classification de l'IA (§5.2, §7.3). */
export const documentClassificationFeedback = pgTable('document_classification_feedback', {
  id: serial('id').primaryKey(),
  fileId: integer('file_id').notNull().references(() => assetFiles.id, { onDelete: 'cascade' }),
  proposedCategoryId: integer('proposed_category_id')
    .references(() => documentCategories.id, { onDelete: 'set null' }),
  proposedTypeCode: text('proposed_type_code'),
  correctedCategoryId: integer('corrected_category_id')
    .references(() => documentCategories.id, { onDelete: 'set null' }),
  correctedTypeCode: text('corrected_type_code'),
  categoryConfidence: numeric('category_confidence'),
  typeConfidence: numeric('type_confidence'),
  pipelineVersion: text('pipeline_version'),
  createdAt: tstz('created_at'),
}, (table) => ({
  dcfFileIdx: index('document_classification_feedback_file_idx2').on(table.fileId),
}));

/** Trace inaltérable des correctifs de référentiel (§6.3). */
export const documentReferenceCorrections = pgTable('document_reference_corrections', {
  id: serial('id').primaryKey(),
  executedAt: tstz('executed_at'),
  executedBy: integer('executed_by').references(() => users.id, { onDelete: 'set null' }),
  correctionType: text('correction_type').notNull(),
  description: text('description').notNull(),
  mappingJson: text('mapping_json'),
  impactCount: integer('impact_count').notNull().default(0),
  appliedCount: integer('applied_count').notNull().default(0),
  unmatchedCount: integer('unmatched_count').notNull().default(0),
});

/**
 * Verrou de tâche planifiée, partagé entre instances.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN VERROU EN BASE ET NON EN MÉMOIRE
 *
 * `analysis-recovery.service` se protégeait par un booléen de module
 * (`isRunning`). Ce verrou ne vaut que dans UN processus : deux instances
 * derrière un répartiteur de charge lancent chacune leur tour, relancent les
 * mêmes documents et consomment deux fois le crédit d'analyse.
 *
 * Un bail daté règle le cas sans dépendre du nombre d'instances : celui qui
 * pose la ligne travaille, les autres passent leur tour. Si le processus
 * meurt, le bail expire et le travail reprend — là où un verrou en mémoire
 * perdu bloquerait jusqu'au redémarrage.
 * ══════════════════════════════════════════════════════════════════════════
 */
export const jobLocks = pgTable('job_locks', {
  /** Identifiant de la tâche, ex. `analysis-recovery`. */
  name: text('name').primaryKey(),
  /** Fin du bail : passé cette date, un autre processus peut reprendre. */
  lockedUntil: pgTimestamp('locked_until', { withTimezone: true }).notNull(),
  /** Détenteur, à titre de journal — jamais utilisé pour décider. */
  lockedBy: text('locked_by'),
  updatedAt: pgTimestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
