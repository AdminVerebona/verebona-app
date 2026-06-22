-- Migration 0056: Migrate all text-based and integer-epoch timestamp columns to TIMESTAMPTZ
--
-- Strategy:
--   • Text ISO-8601 columns → USING col::timestamptz
--   • Integer unix-epoch-milliseconds (inviteTokenExpiresAt) → USING to_timestamp(col::bigint / 1000.0)
--   • NULL-safe: USING expressions handle NULLs correctly in Postgres
--
-- Run with: psql ... -f 0056_timestamps_to_timestamptz.sql
-- Idempotent: safe to re-run (ALTER TYPE on already-timestamptz column is a no-op in Postgres 14+)

-- ─── users ────────────────────────────────────────────────────────────────────
ALTER TABLE users
  ALTER COLUMN last_login_at    TYPE TIMESTAMPTZ USING last_login_at::timestamptz,
  ALTER COLUMN accepted_terms_at TYPE TIMESTAMPTZ USING accepted_terms_at::timestamptz,
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at       TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── assets ───────────────────────────────────────────────────────────────────
ALTER TABLE assets
  ALTER COLUMN deleted_at  TYPE TIMESTAMPTZ USING deleted_at::timestamptz,
  ALTER COLUMN created_at  TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at  TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── rooms ────────────────────────────────────────────────────────────────────
ALTER TABLE rooms
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── documents (deprecated) ───────────────────────────────────────────────────
ALTER TABLE documents
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── events ───────────────────────────────────────────────────────────────────
ALTER TABLE events
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── calendar_additions ───────────────────────────────────────────────────────
ALTER TABLE calendar_additions
  ALTER COLUMN last_added_at  TYPE TIMESTAMPTZ USING last_added_at::timestamptz,
  ALTER COLUMN dismissed_at   TYPE TIMESTAMPTZ USING dismissed_at::timestamptz,
  ALTER COLUMN created_at     TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at     TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── deadlines ────────────────────────────────────────────────────────────────
ALTER TABLE deadlines
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── substructures ────────────────────────────────────────────────────────────
ALTER TABLE substructures
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── equipments ───────────────────────────────────────────────────────────────
ALTER TABLE equipments
  ALTER COLUMN archived_at TYPE TIMESTAMPTZ USING archived_at::timestamptz,
  ALTER COLUMN created_at  TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at  TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── asset_types / asset_type_subcategories ───────────────────────────────────
ALTER TABLE asset_types
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE asset_type_subcategories
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── email_templates ──────────────────────────────────────────────────────────
ALTER TABLE email_templates
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── admin_audit_log ─────────────────────────────────────────────────────────
ALTER TABLE admin_audit_log
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ USING timestamp::timestamptz;

-- ─── asset_files ──────────────────────────────────────────────────────────────
ALTER TABLE asset_files
  ALTER COLUMN uploaded_at TYPE TIMESTAMPTZ USING uploaded_at::timestamptz,
  ALTER COLUMN deleted_at  TYPE TIMESTAMPTZ USING deleted_at::timestamptz,
  ALTER COLUMN created_at  TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at  TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── document_versions ────────────────────────────────────────────────────────
ALTER TABLE document_versions
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── system_files ─────────────────────────────────────────────────────────────
ALTER TABLE system_files
  ALTER COLUMN uploaded_at TYPE TIMESTAMPTZ USING uploaded_at::timestamptz,
  ALTER COLUMN deleted_at  TYPE TIMESTAMPTZ USING deleted_at::timestamptz,
  ALTER COLUMN created_at  TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at  TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── email_settings ───────────────────────────────────────────────────────────
ALTER TABLE email_settings
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── email_logs ───────────────────────────────────────────────────────────────
ALTER TABLE email_logs
  ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING sent_at::timestamptz;

-- ─── user_activity_log ────────────────────────────────────────────────────────
ALTER TABLE user_activity_log
  ALTER COLUMN timestamp  TYPE TIMESTAMPTZ USING timestamp::timestamptz,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── subscription_history ─────────────────────────────────────────────────────
-- created_at was stored as unix-epoch milliseconds (integer)
ALTER TABLE subscription_history
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING to_timestamp(created_at::bigint / 1000.0);

-- ─── stripe_webhook_logs ──────────────────────────────────────────────────────
-- created_at was stored as unix-epoch milliseconds (integer)
ALTER TABLE stripe_webhook_logs
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING to_timestamp(created_at::bigint / 1000.0);

-- ─── invoices ─────────────────────────────────────────────────────────────────
-- created_at / updated_at / paid_at were stored as unix-epoch milliseconds
ALTER TABLE invoices
  ALTER COLUMN paid_at     TYPE TIMESTAMPTZ USING CASE WHEN paid_at IS NULL THEN NULL ELSE to_timestamp(paid_at::bigint / 1000.0) END,
  ALTER COLUMN created_at  TYPE TIMESTAMPTZ USING to_timestamp(created_at::bigint / 1000.0),
  ALTER COLUMN updated_at  TYPE TIMESTAMPTZ USING to_timestamp(updated_at::bigint / 1000.0);

-- ─── plan_configs ─────────────────────────────────────────────────────────────
-- updated_at was stored as unix-epoch milliseconds (integer)
ALTER TABLE plan_configs
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING to_timestamp(updated_at::bigint / 1000.0);

-- ─── asset_photos ─────────────────────────────────────────────────────────────
ALTER TABLE asset_photos
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── export_templates ─────────────────────────────────────────────────────────
ALTER TABLE export_templates
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── system_logos ─────────────────────────────────────────────────────────────
ALTER TABLE system_logos
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── document_types ───────────────────────────────────────────────────────────
ALTER TABLE document_types
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── document_type_asset_associations ────────────────────────────────────────
ALTER TABLE document_type_asset_associations
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── document_type_export_associations ───────────────────────────────────────
ALTER TABLE document_type_export_associations
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── event_documents ─────────────────────────────────────────────────────────
ALTER TABLE event_documents
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── accounts ─────────────────────────────────────────────────────────────────
ALTER TABLE accounts
  ALTER COLUMN plan_renewal_date              TYPE TIMESTAMPTZ USING plan_renewal_date::timestamptz,
  ALTER COLUMN subscription_started_at        TYPE TIMESTAMPTZ USING subscription_started_at::timestamptz,
  ALTER COLUMN calendar_share_token_created_at TYPE TIMESTAMPTZ USING calendar_share_token_created_at::timestamptz,
  ALTER COLUMN created_at                     TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at                     TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── account_memberships ─────────────────────────────────────────────────────
-- invite_token_expires_at was stored as unix-epoch milliseconds (integer)
ALTER TABLE account_memberships
  ALTER COLUMN invited_at               TYPE TIMESTAMPTZ USING invited_at::timestamptz,
  ALTER COLUMN joined_at                TYPE TIMESTAMPTZ USING joined_at::timestamptz,
  ALTER COLUMN removed_at               TYPE TIMESTAMPTZ USING removed_at::timestamptz,
  ALTER COLUMN invite_token_expires_at  TYPE TIMESTAMPTZ USING to_timestamp(invite_token_expires_at::bigint / 1000.0),
  ALTER COLUMN created_at               TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at               TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── account_audit_log ───────────────────────────────────────────────────────
ALTER TABLE account_audit_log
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ USING timestamp::timestamptz;

-- ─── duo_accounts ─────────────────────────────────────────────────────────────
ALTER TABLE duo_accounts
  ALTER COLUMN activated_at                    TYPE TIMESTAMPTZ USING activated_at::timestamptz,
  ALTER COLUMN first_payment_failed_at         TYPE TIMESTAMPTZ USING first_payment_failed_at::timestamptz,
  ALTER COLUMN grace_deadline_at               TYPE TIMESTAMPTZ USING grace_deadline_at::timestamptz,
  ALTER COLUMN pending_invite_token_expires_at TYPE TIMESTAMPTZ USING pending_invite_token_expires_at::timestamptz,
  ALTER COLUMN pending_invite_sent_at          TYPE TIMESTAMPTZ USING pending_invite_sent_at::timestamptz,
  ALTER COLUMN created_at                      TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at                      TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── duo_memberships ──────────────────────────────────────────────────────────
ALTER TABLE duo_memberships
  ALTER COLUMN invited_at TYPE TIMESTAMPTZ USING invited_at::timestamptz,
  ALTER COLUMN joined_at  TYPE TIMESTAMPTZ USING joined_at::timestamptz,
  ALTER COLUMN left_at    TYPE TIMESTAMPTZ USING left_at::timestamptz,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── asset_move_requests ──────────────────────────────────────────────────────
ALTER TABLE asset_move_requests
  ALTER COLUMN resolved_at TYPE TIMESTAMPTZ USING resolved_at::timestamptz,
  ALTER COLUMN created_at  TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── asset_delete_requests ────────────────────────────────────────────────────
ALTER TABLE asset_delete_requests
  ALTER COLUMN resolved_at TYPE TIMESTAMPTZ USING resolved_at::timestamptz,
  ALTER COLUMN created_at  TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── notifications ────────────────────────────────────────────────────────────
ALTER TABLE notifications
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN read_at    TYPE TIMESTAMPTZ USING read_at::timestamptz;

-- ─── dunning_events ───────────────────────────────────────────────────────────
ALTER TABLE dunning_events
  ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING sent_at::timestamptz;

-- ─── idempotency_keys ─────────────────────────────────────────────────────────
ALTER TABLE idempotency_keys
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz;

-- ─── pending_blob_deletions ───────────────────────────────────────────────────
ALTER TABLE pending_blob_deletions
  ALTER COLUMN scheduled_for TYPE TIMESTAMPTZ USING scheduled_for::timestamptz,
  ALTER COLUMN processed_at  TYPE TIMESTAMPTZ USING processed_at::timestamptz,
  ALTER COLUMN created_at    TYPE TIMESTAMPTZ USING created_at::timestamptz;

-- ─── asset_custom_fields / asset_custom_field_values ─────────────────────────
ALTER TABLE asset_custom_fields
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE asset_custom_field_values
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── agenda_items ─────────────────────────────────────────────────────────────
ALTER TABLE agenda_items
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── agenda_data_conflicts ────────────────────────────────────────────────────
ALTER TABLE agenda_data_conflicts
  ALTER COLUMN resolved_at TYPE TIMESTAMPTZ USING resolved_at::timestamptz,
  ALTER COLUMN created_at  TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN updated_at  TYPE TIMESTAMPTZ USING updated_at::timestamptz;

-- ─── export_generation ────────────────────────────────────────────────────────
ALTER TABLE export_generation
  ALTER COLUMN generation_started_at TYPE TIMESTAMPTZ USING generation_started_at::timestamptz,
  ALTER COLUMN created_at            TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN completed_at          TYPE TIMESTAMPTZ USING completed_at::timestamptz;

-- ─── asset_transmissions ──────────────────────────────────────────────────────
ALTER TABLE asset_transmissions
  ALTER COLUMN sent_at      TYPE TIMESTAMPTZ USING sent_at::timestamptz,
  ALTER COLUMN accepted_at  TYPE TIMESTAMPTZ USING accepted_at::timestamptz,
  ALTER COLUMN refused_at   TYPE TIMESTAMPTZ USING refused_at::timestamptz,
  ALTER COLUMN cancelled_at TYPE TIMESTAMPTZ USING cancelled_at::timestamptz,
  ALTER COLUMN created_at   TYPE TIMESTAMPTZ USING created_at::timestamptz;
