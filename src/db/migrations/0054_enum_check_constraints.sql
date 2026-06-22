-- Migration 0054: DB-level CHECK constraints for all canonical enums
-- Mirrors the TypeScript enum constants in src/types/domain.ts
-- Purpose: catch any invalid value written to DB at the earliest possible point.
-- Convention:
--   users.plan_type, users.role, users.status           → SCREAMING_SNAKE_CASE
--   accounts.subscription_tier                           → snake_case lowercase (Stripe tiers)
--   accounts.subscription_status                         → SCREAMING_SNAKE_CASE
--   account_memberships.status                           → snake_case lowercase
--   account_memberships.role                             → snake_case lowercase
--   agenda_items.origin_type, manual_status              → snake_case lowercase

-- ── users ─────────────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD CONSTRAINT chk_users_plan_type
    CHECK (plan_type IN ('FREEMIUM', 'PREMIUM', 'DUO', 'ENTERPRISE'));

ALTER TABLE users
  ADD CONSTRAINT chk_users_role
    CHECK (role IN ('USER', 'ADMIN', 'SUPER_ADMIN'));

ALTER TABLE users
  ADD CONSTRAINT chk_users_status
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED'));

-- ── accounts ─────────────────────────────────────────────────────────────────

ALTER TABLE accounts
  ADD CONSTRAINT chk_accounts_subscription_tier
    CHECK (subscription_tier IN ('free', 'premium', 'pro'));

ALTER TABLE accounts
  ADD CONSTRAINT chk_accounts_subscription_status
    CHECK (subscription_status IN (
      'NONE', 'ACTIVE', 'CANCELED', 'EXPIRED',
      'PAST_DUE', 'PAST_DUE_GRACE', 'UNPAID_RECOVERY', 'TRIALING'
    ));

-- ── account_memberships ───────────────────────────────────────────────────────

ALTER TABLE account_memberships
  ADD CONSTRAINT chk_memberships_status
    CHECK (status IN ('active', 'pending', 'removed'));

ALTER TABLE account_memberships
  ADD CONSTRAINT chk_memberships_role
    CHECK (role IN ('owner', 'admin', 'member'));

-- ── agenda_items ──────────────────────────────────────────────────────────────

ALTER TABLE agenda_items
  ADD CONSTRAINT chk_agenda_items_manual_status
    CHECK (manual_status IS NULL OR manual_status IN ('realise', 'annule'));

ALTER TABLE agenda_items
  ADD CONSTRAINT chk_agenda_items_origin_type
    CHECK (origin_type IN (
      'manual', 'asset_field', 'qualified_document', 'deduced_rule',
      'legacy_event_migration', 'legacy_deadline_migration'
    ));
