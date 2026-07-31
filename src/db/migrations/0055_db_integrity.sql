-- Gardes ajoutées : index et contraintes peuvent déjà exister lorsque le
-- schéma vient de `drizzle-kit push`. `ADD CONSTRAINT` n'acceptant pas
-- `IF NOT EXISTS`, chaque contrainte est retirée puis reposée.

-- Migration 0055: DB integrity — real unique constraints, missing FKs, business CHECKs
-- Replaces false index() "unique" markers with proper UNIQUE constraints,
-- adds missing foreign keys, and pushes business-rule invariants into the DB.

-- ─── 1. event_documents: fake unique index → real unique constraint ───────────
DROP INDEX IF EXISTS event_documents_unique_idx;
ALTER TABLE event_documents DROP CONSTRAINT IF EXISTS event_documents_event_file_unique;
ALTER TABLE event_documents ADD CONSTRAINT event_documents_event_file_unique UNIQUE (event_id, file_id);

-- ─── 2. dunning_events: fake unique index → real unique constraint ────────────
DROP INDEX IF EXISTS dunning_events_duo_id_stage_unique_idx;
ALTER TABLE dunning_events DROP CONSTRAINT IF EXISTS dunning_events_duo_stage_unique;
ALTER TABLE dunning_events ADD CONSTRAINT dunning_events_duo_stage_unique UNIQUE (duo_id, stage);

-- ─── 3. account_memberships: fake unique index → partial unique constraint ────
-- Old non-partial index on (account_id, user_id) allowed multiple NULL-user rows
-- (which is correct for invite-only rows). Replace with a partial unique constraint
-- that only enforces uniqueness when user_id is known.
DROP INDEX IF EXISTS account_memberships_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS account_memberships_unique_active_idx
  ON account_memberships (account_id, user_id)
  WHERE user_id IS NOT NULL;

-- ─── 4. accounts: FK to duo_accounts ─────────────────────────────────────────
-- The comment said "FK enforced at DB level" but the constraint was missing.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_duo_account_id_fkey;
ALTER TABLE accounts ADD CONSTRAINT accounts_duo_account_id_fkey
    FOREIGN KEY (duo_account_id) REFERENCES duo_accounts(id) ON DELETE SET NULL;

-- ─── 5. assets: FK to duo_accounts ───────────────────────────────────────────
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_duo_id_fkey;
ALTER TABLE assets ADD CONSTRAINT assets_duo_id_fkey
    FOREIGN KEY (duo_id) REFERENCES duo_accounts(id) ON DELETE SET NULL;

-- ─── 6. assets: FK to asset_move_requests (copy provenance) ──────────────────
-- Not expressible in Drizzle (circular dep), enforced here only.
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_copy_source_request_id_fkey;
ALTER TABLE assets ADD CONSTRAINT assets_copy_source_request_id_fkey
    FOREIGN KEY (copy_source_request_id) REFERENCES asset_move_requests(id) ON DELETE SET NULL;

-- ─── 7. document_versions: unique (file_id, version_number) ──────────────────
ALTER TABLE document_versions DROP CONSTRAINT IF EXISTS document_versions_file_version_unique;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_file_version_unique UNIQUE (file_id, version_number);

-- ─── 8. duo_memberships: unique (duo_id, user_id) ────────────────────────────
ALTER TABLE duo_memberships DROP CONSTRAINT IF EXISTS duo_memberships_duo_user_unique;
ALTER TABLE duo_memberships ADD CONSTRAINT duo_memberships_duo_user_unique UNIQUE (duo_id, user_id);

-- ─── 9. asset_custom_field_values: unique (asset_id, field_id) ───────────────
ALTER TABLE asset_custom_field_values DROP CONSTRAINT IF EXISTS asset_custom_field_values_asset_field_unique;
ALTER TABLE asset_custom_field_values ADD CONSTRAINT asset_custom_field_values_asset_field_unique UNIQUE (asset_id, field_id);

-- ─── 10. document_type_asset_associations: unique (doc_type, asset_type, subcat) ─
-- NULLs are distinct in unique indexes in Postgres, which is correct here
-- (a row with asset_type_id=NULL means "applies to all asset types").
ALTER TABLE document_type_asset_associations DROP CONSTRAINT IF EXISTS doc_type_asset_assoc_unique;
ALTER TABLE document_type_asset_associations ADD CONSTRAINT doc_type_asset_assoc_unique
    UNIQUE (document_type_id, asset_type_id, asset_type_subcategory_id);

-- ─── 11. document_type_export_associations: unique (doc_type, export_template) ─
ALTER TABLE document_type_export_associations DROP CONSTRAINT IF EXISTS doc_type_export_assoc_unique;
ALTER TABLE document_type_export_associations ADD CONSTRAINT doc_type_export_assoc_unique
    UNIQUE (document_type_id, export_template_id);

-- ─── 12. accounts: business CHECK constraints ────────────────────────────────
-- Drop 0054 constraint (missing 'ENTERPRISE') and replace with complete set
ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS chk_accounts_subscription_status;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_plan_type_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_subscription_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_plan_type_check
    CHECK (plan_type IN ('FREEMIUM', 'PREMIUM', 'DUO', 'ENTERPRISE')),
  ADD CONSTRAINT accounts_subscription_status_check
    CHECK (subscription_status IN (
      'NONE','ACTIVE','CANCELED','EXPIRED',
      'PAST_DUE','PAST_DUE_GRACE','UNPAID_RECOVERY','TRIALING'
    ));

-- ─── 13. account_memberships: business CHECK constraints ─────────────────────
-- Drop 0054 constraints (missing 'declined' in status) and replace with complete set
ALTER TABLE account_memberships
  DROP CONSTRAINT IF EXISTS chk_memberships_status,
  DROP CONSTRAINT IF EXISTS chk_memberships_role;
ALTER TABLE account_memberships DROP CONSTRAINT IF EXISTS account_memberships_role_check;
ALTER TABLE account_memberships DROP CONSTRAINT IF EXISTS account_memberships_status_check;
ALTER TABLE account_memberships ADD CONSTRAINT account_memberships_role_check
    CHECK (role IN ('owner', 'member', 'admin')),
  ADD CONSTRAINT account_memberships_status_check
    CHECK (status IN ('pending', 'active', 'removed', 'declined'));

-- ─── 14. assets: business CHECK constraints ──────────────────────────────────
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_lock_state_check;
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check;
ALTER TABLE assets ADD CONSTRAINT assets_lock_state_check
    CHECK (lock_state IN ('NONE', 'SOFT', 'HARD')),
  ADD CONSTRAINT assets_status_check
    CHECK (status IN ('EN_SERVICE', 'EN_MAINTENANCE', 'HORS_SERVICE', 'ARCHIVED'));

-- ─── 15. duo_memberships: business CHECK constraint ──────────────────────────
ALTER TABLE duo_memberships DROP CONSTRAINT IF EXISTS duo_memberships_status_check;
ALTER TABLE duo_memberships ADD CONSTRAINT duo_memberships_status_check
    CHECK (status IN ('INVITED', 'ACTIVE', 'LEFT', 'REMOVED'));
