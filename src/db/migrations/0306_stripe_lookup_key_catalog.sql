-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0306 : catalogue Stripe par lookup_key (lot 35C, CDC « Migration
-- Stripe vers lookup_key » V4, LK-17 à LK-20, LK-44, LK-70, LK-75, EX-001 à
-- EX-018).
--
-- ADDITIVE ET SANS APPEL STRIPE (LK-84, D2) : tables neuves et colonnes
-- NULLables ; aucune colonne supprimée (transition contrôlée) ; les migrations
-- 0066, 0072 et 0180 ne sont pas réécrites. Les données sont alimentées
-- ensuite, automatiquement, par la reprise historique (tâche planifiée
-- `stripe-catalog-sync`) — jamais par cette migration.
--
--   stripe_catalog_products   produits Stripe approuvés par offre et contexte
--                             (vente / reconnaissance historique, LK-03) ;
--   stripe_price_versions     registre durable des Price connus (LK-17) ;
--   stripe_catalog_state      état partagé du catalogue par contexte :
--                             révision active, précédente (rollback),
--                             génération d'invalidation, état de publication
--                             (LK-18, LK-24, EX-001, EX-002) ;
--   stripe_catalog_runs       journal des synchronisations, reprises,
--                             publications et retours arrière (EX-002) ;
--   billing_price_operations  opérations engageant un prix (Checkout,
--                             montée en gamme, programmation, admin) : prix et
--                             révision acceptés, idempotence (LK-40, LK-44,
--                             LK-45, LK-54, LK-63) ;
--   stripe_price_migrations   campagne de revalorisation des abonnés existants
--                             (EX-016 à EX-018) ;
--   stripe_invoice_effects    idempotence MÉTIER des effets d'un paiement
--                             (invoice.paid / invoice.payment_succeeded, LK-70).
--
-- Colonnes : prix contractuel de l'abonnement et cible exacte d'un changement
-- programmé (account_subscriptions, LK-19, LK-20), détail multiligne des
-- factures (invoices, LK-75), prise en charge atomique des webhooks
-- (stripe_webhook_logs.claimed_at, LK-70).
--
-- Index secondaires des tables EXISTANTES : `0306_idx_1` (CONCURRENTLY).
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

-- ── Produits approuvés ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_catalog_products (
  id                 BIGSERIAL    PRIMARY KEY,
  catalog_context    TEXT         NOT NULL,
  stripe_account_id  TEXT,
  livemode           BOOLEAN,
  plan_code          TEXT         NOT NULL,
  stripe_product_id  TEXT         NOT NULL,
  role               TEXT         NOT NULL DEFAULT 'historical',
  source             TEXT         NOT NULL,
  approved_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT stripe_catalog_products_plan_chk CHECK (plan_code IN ('standard', 'premium', 'premium_duo')),
  CONSTRAINT stripe_catalog_products_role_chk CHECK (role IN ('sale', 'historical')),
  CONSTRAINT stripe_catalog_products_uniq UNIQUE (catalog_context, stripe_product_id)
);
-- Un seul produit DE VENTE par offre et par contexte (table neuve : instantané).
CREATE UNIQUE INDEX IF NOT EXISTS stripe_catalog_products_sale_uidx
  ON stripe_catalog_products (catalog_context, plan_code) WHERE role = 'sale';

-- ── Registre des versions de prix ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_price_versions (
  id                   BIGSERIAL    PRIMARY KEY,
  catalog_context      TEXT         NOT NULL,
  stripe_account_id    TEXT,
  livemode             BOOLEAN,
  stripe_price_id      TEXT         NOT NULL,
  stripe_product_id    TEXT         NOT NULL,
  plan_code            TEXT         NOT NULL,
  billing_period       TEXT         NOT NULL,
  logical_lookup_key   TEXT         NOT NULL,
  observed_lookup_key  TEXT,
  unit_amount_cents    INTEGER      NOT NULL,
  currency             TEXT         NOT NULL,
  interval             TEXT         NOT NULL,
  interval_count       INTEGER      NOT NULL DEFAULT 1,
  tax_behavior         TEXT         NOT NULL DEFAULT 'unspecified',
  price_revision       TEXT         NOT NULL,
  stripe_active        BOOLEAN      NOT NULL DEFAULT TRUE,
  source               TEXT         NOT NULL,
  first_seen_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_verified_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT stripe_price_versions_plan_chk CHECK (plan_code IN ('standard', 'premium', 'premium_duo')),
  CONSTRAINT stripe_price_versions_period_chk CHECK (billing_period IN ('monthly', 'yearly')),
  CONSTRAINT stripe_price_versions_amount_chk CHECK (unit_amount_cents > 0),
  CONSTRAINT stripe_price_versions_uniq UNIQUE (catalog_context, stripe_price_id)
);

-- ── État partagé du catalogue ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_catalog_state (
  catalog_context              TEXT         PRIMARY KEY,
  stripe_account_id            TEXT,
  livemode                     BOOLEAN,
  active_revision              TEXT,
  active_snapshot              JSONB,
  previous_revision            TEXT,
  previous_snapshot            JSONB,
  verified_at                  TIMESTAMPTZ,
  generation                   INTEGER      NOT NULL DEFAULT 0,
  invalidated_at               TIMESTAMPTZ,
  publication_state            TEXT         NOT NULL DEFAULT 'ACTIVE',
  publication_run_id           BIGINT,
  publication_error            TEXT,
  activating_until             TIMESTAMPTZ,
  published_manifest_revision  TEXT,
  candidate_manifest_revision  TEXT,
  candidate_first_seen_at      TIMESTAMPTZ,
  portal_configuration_id      TEXT,
  portal_fingerprint           TEXT,
  portal_verified_at           TIMESTAMPTZ,
  backfill_completed_at        TIMESTAMPTZ,
  last_sync_error              TEXT,
  updated_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT stripe_catalog_state_publication_chk CHECK (publication_state IN
    ('PREPARED', 'VALIDATING', 'PUBLISHING', 'READY', 'ACTIVE', 'FAILED', 'RECOVERING', 'SUPERSEDED'))
);

-- ── Journal des opérations de catalogue ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_catalog_runs (
  id                   BIGSERIAL    PRIMARY KEY,
  catalog_context      TEXT         NOT NULL,
  kind                 TEXT         NOT NULL,
  state                TEXT         NOT NULL,
  trigger              TEXT         NOT NULL,
  actor                TEXT,
  code_version         TEXT,
  manifest_revision    TEXT,
  from_revision        TEXT,
  to_revision          TEXT,
  dry_run              BOOLEAN      NOT NULL DEFAULT FALSE,
  steps                JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_prices       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  transfers            JSONB        NOT NULL DEFAULT '[]'::jsonb,
  report               JSONB,
  error                TEXT,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at          TIMESTAMPTZ,
  CONSTRAINT stripe_catalog_runs_kind_chk CHECK (kind IN ('sync', 'backfill', 'publish', 'rollback', 'revaluation')),
  CONSTRAINT stripe_catalog_runs_state_chk CHECK (state IN
    ('PREPARED', 'VALIDATING', 'PUBLISHING', 'READY', 'ACTIVE', 'FAILED', 'RECOVERING', 'SUPERSEDED', 'DONE', 'NOOP'))
);
CREATE INDEX IF NOT EXISTS stripe_catalog_runs_context_idx
  ON stripe_catalog_runs (catalog_context, started_at DESC);

-- ── Opérations engageant un prix ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_price_operations (
  id                   BIGSERIAL    PRIMARY KEY,
  catalog_context      TEXT         NOT NULL,
  kind                 TEXT         NOT NULL,
  account_id           INTEGER      REFERENCES accounts(id) ON DELETE SET NULL,
  user_id              INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  plan_code            TEXT         NOT NULL,
  billing_period       TEXT         NOT NULL,
  stripe_price_id      TEXT         NOT NULL,
  price_revision       TEXT         NOT NULL,
  unit_amount_cents    INTEGER      NOT NULL,
  currency             TEXT         NOT NULL DEFAULT 'eur',
  previous_price_id    TEXT,
  previous_amount_cents INTEGER,
  idempotency_key      TEXT         NOT NULL,
  promo_context        TEXT,
  referral_code        TEXT,
  status               TEXT         NOT NULL DEFAULT 'reserved',
  stripe_reference     TEXT,
  error                TEXT,
  initiator            TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_price_operations_kind_chk CHECK (kind IN ('checkout', 'upgrade', 'schedule', 'admin')),
  CONSTRAINT billing_price_operations_status_chk CHECK (status IN
    ('reserved', 'created', 'completed', 'expired', 'superseded', 'failed', 'uncertain')),
  CONSTRAINT billing_price_operations_idem_uniq UNIQUE (idempotency_key)
);
-- Une seule tentative de souscription OUVERTE par compte (LK-44).
CREATE UNIQUE INDEX IF NOT EXISTS billing_price_operations_open_checkout_uidx
  ON billing_price_operations (account_id)
  WHERE kind = 'checkout' AND status IN ('reserved', 'created', 'uncertain');
CREATE INDEX IF NOT EXISTS billing_price_operations_account_idx
  ON billing_price_operations (account_id, created_at DESC);

-- ── Campagne de revalorisation des abonnés existants ────────────────────────
CREATE TABLE IF NOT EXISTS stripe_price_migrations (
  id                       BIGSERIAL    PRIMARY KEY,
  catalog_context          TEXT         NOT NULL,
  revision_id              TEXT         NOT NULL,
  account_id               INTEGER      REFERENCES accounts(id) ON DELETE SET NULL,
  stripe_customer_id       TEXT,
  stripe_subscription_id   TEXT         NOT NULL,
  stripe_subscription_item_id TEXT      NOT NULL,
  plan_code                TEXT         NOT NULL,
  billing_period           TEXT         NOT NULL,
  subscription_status      TEXT,
  old_price_id             TEXT         NOT NULL,
  old_amount_cents         INTEGER,
  target_price_id          TEXT         NOT NULL,
  target_amount_cents      INTEGER      NOT NULL,
  renewal_at               TIMESTAMPTZ,
  has_discount             BOOLEAN      NOT NULL DEFAULT FALSE,
  has_schedule             BOOLEAN      NOT NULL DEFAULT FALSE,
  eligibility_status       TEXT         NOT NULL DEFAULT 'pending',
  eligibility_reason       TEXT,
  notification_status      TEXT         NOT NULL DEFAULT 'pending',
  notification_proof       JSONB,
  notified_at              TIMESTAMPTZ,
  notice_deadline          TIMESTAMPTZ,
  migration_status         TEXT         NOT NULL DEFAULT 'planned',
  schedule_id              TEXT,
  attempts                 INTEGER      NOT NULL DEFAULT 0,
  last_error               TEXT,
  evidence                 JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT stripe_price_migrations_eligibility_chk CHECK (eligibility_status IN ('pending', 'eligible', 'deferred', 'excluded')),
  CONSTRAINT stripe_price_migrations_notification_chk CHECK (notification_status IN ('pending', 'sent', 'proven', 'failed')),
  CONSTRAINT stripe_price_migrations_status_chk CHECK (migration_status IN
    ('planned', 'scheduled', 'completed', 'deferred', 'failed', 'canceled', 'retryable', 'blocked')),
  CONSTRAINT stripe_price_migrations_item_uniq UNIQUE (revision_id, stripe_subscription_item_id)
);
CREATE INDEX IF NOT EXISTS stripe_price_migrations_status_idx
  ON stripe_price_migrations (catalog_context, migration_status);
CREATE INDEX IF NOT EXISTS stripe_price_migrations_subscription_idx
  ON stripe_price_migrations (stripe_subscription_id);

-- ── Idempotence métier des effets de paiement ───────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_invoice_effects (
  stripe_invoice_id  TEXT         NOT NULL,
  effect             TEXT         NOT NULL,
  event_id           TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stripe_invoice_id, effect)
);

-- ── Colonnes des tables existantes ──────────────────────────────────────────
ALTER TABLE account_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_subscription_item_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_price_id             TEXT,
  ADD COLUMN IF NOT EXISTS stripe_product_id           TEXT,
  ADD COLUMN IF NOT EXISTS contract_unit_amount_cents  INTEGER,
  ADD COLUMN IF NOT EXISTS contract_currency           TEXT,
  ADD COLUMN IF NOT EXISTS contract_quantity           INTEGER,
  ADD COLUMN IF NOT EXISTS contract_interval           TEXT,
  ADD COLUMN IF NOT EXISTS contract_tax_behavior       TEXT,
  ADD COLUMN IF NOT EXISTS contract_verified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contract_price_since        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS previous_unit_amount_cents  INTEGER,
  ADD COLUMN IF NOT EXISTS scheduled_stripe_price_id   TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_price_revision    TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_unit_amount_cents INTEGER,
  ADD COLUMN IF NOT EXISTS scheduled_currency          TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_schedule_id       TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_change_state      TEXT;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS line_items_json  JSONB,
  ADD COLUMN IF NOT EXISTS plan_resolution  TEXT;

ALTER TABLE stripe_webhook_logs
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
