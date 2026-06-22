-- Commercial model migration: Standard/Premium/Premium Duo + IA quotas/packs/referral

-- 1) Broaden plan checks (legacy + new model)
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_plan_type_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_plan_type_check
  CHECK (plan_type IN ('STANDARD', 'PREMIUM', 'DUO', 'PREMIUM_DUO', 'PRO'));

-- 2) Reference data
CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  yearly_price_cents INTEGER,
  monthly_equivalent_cents INTEGER,
  stripe_price_id TEXT,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  is_subscribable BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_plans_code_idx ON subscription_plans (code);
CREATE INDEX IF NOT EXISTS subscription_plans_display_order_idx ON subscription_plans (display_order);

CREATE TABLE IF NOT EXISTS plan_limits (
  id SERIAL PRIMARY KEY,
  plan_code TEXT NOT NULL,
  max_assets INTEGER NOT NULL,
  max_users INTEGER NOT NULL DEFAULT 1,
  trial_analysis_quota INTEGER NOT NULL,
  yearly_analysis_quota INTEGER NOT NULL,
  features_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_limits_plan_code_uidx ON plan_limits (plan_code);

CREATE TABLE IF NOT EXISTS analysis_packs (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  credit_amount INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  eligible_plans_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analysis_packs_code_idx ON analysis_packs (code);
CREATE INDEX IF NOT EXISTS analysis_packs_active_idx ON analysis_packs (is_active);

-- 3) Runtime subscription mirror + counters/credits
CREATE TABLE IF NOT EXISTS account_subscriptions (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  current_period_start_at TIMESTAMPTZ,
  current_period_end_at TIMESTAMPTZ,
  first_billed_at TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_subscriptions_account_id_idx ON account_subscriptions (account_id);
CREATE INDEX IF NOT EXISTS account_subscriptions_plan_code_idx ON account_subscriptions (plan_code);
CREATE INDEX IF NOT EXISTS account_subscriptions_status_idx ON account_subscriptions (status);
CREATE INDEX IF NOT EXISTS account_subscriptions_stripe_customer_id_idx ON account_subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS account_subscriptions_stripe_subscription_id_idx ON account_subscriptions (stripe_subscription_id);

CREATE TABLE IF NOT EXISTS account_analysis_counters (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL,
  period_start_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_end_at TIMESTAMPTZ,
  included_quota INTEGER NOT NULL,
  included_consumed INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_analysis_counters_account_id_idx ON account_analysis_counters (account_id);
CREATE INDEX IF NOT EXISTS account_analysis_counters_period_type_idx ON account_analysis_counters (period_type);
CREATE UNIQUE INDEX IF NOT EXISTS account_analysis_counters_active_period_uidx ON account_analysis_counters (account_id, period_type) WHERE period_end_at IS NULL;

CREATE TABLE IF NOT EXISTS account_analysis_credits (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  pack_code TEXT,
  stripe_invoice_id TEXT,
  amount_initial INTEGER NOT NULL,
  amount_remaining INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_analysis_credits_account_id_idx ON account_analysis_credits (account_id);
CREATE INDEX IF NOT EXISTS account_analysis_credits_source_idx ON account_analysis_credits (source);

-- 4) Referral
CREATE TABLE IF NOT EXISTS referral_links (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_links_code_idx ON referral_links (code);
CREATE INDEX IF NOT EXISTS referral_links_account_id_idx ON referral_links (account_id);

CREATE TABLE IF NOT EXISTS referral_events (
  id SERIAL PRIMARY KEY,
  referral_link_id INTEGER REFERENCES referral_links(id) ON DELETE SET NULL,
  referrer_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  referred_account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  referred_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'link_used',
  reward_credits INTEGER NOT NULL DEFAULT 10,
  reward_granted_at TIMESTAMPTZ,
  first_billed_at TIMESTAMPTZ,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_events_referrer_account_id_idx ON referral_events (referrer_account_id);
CREATE INDEX IF NOT EXISTS referral_events_referred_account_id_idx ON referral_events (referred_account_id);
CREATE INDEX IF NOT EXISTS referral_events_status_idx ON referral_events (status);

-- 5) Notification idempotence + internal IA tracking
CREATE TABLE IF NOT EXISTS notification_events (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_counter_id INTEGER REFERENCES account_analysis_counters(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_events_account_id_idx ON notification_events (account_id);
CREATE INDEX IF NOT EXISTS notification_events_event_type_idx ON notification_events (event_type);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  feature TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL,
  estimated_cost_cents NUMERIC(10,4),
  fallback_reason TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_events_account_id_idx ON ai_usage_events (account_id);
CREATE INDEX IF NOT EXISTS ai_usage_events_feature_idx ON ai_usage_events (feature);
CREATE INDEX IF NOT EXISTS ai_usage_events_status_idx ON ai_usage_events (status);

-- 6) Seeds
INSERT INTO subscription_plans (code, label, yearly_price_cents, monthly_equivalent_cents, is_visible, is_subscribable, display_order)
VALUES
  ('standard', 'Standard', 1900, 158, true, true, 1),
  ('premium', 'Premium', 5900, 492, true, true, 2),
  ('premium_duo', 'Premium Duo', 7900, 658, true, true, 3),
  ('premium_pro', 'Premium Pro', NULL, NULL, true, false, 4)
ON CONFLICT (code) DO UPDATE
SET label = EXCLUDED.label,
    yearly_price_cents = EXCLUDED.yearly_price_cents,
    monthly_equivalent_cents = EXCLUDED.monthly_equivalent_cents,
    is_visible = EXCLUDED.is_visible,
    is_subscribable = EXCLUDED.is_subscribable,
    display_order = EXCLUDED.display_order,
    updated_at = now();

INSERT INTO plan_limits (plan_code, max_assets, max_users, trial_analysis_quota, yearly_analysis_quota, features_json, updated_at)
VALUES
  ('standard', 2, 1, 10, 50, '{"rooms":false,"equipments":false,"externalCalendar":false,"advancedExports":false}'::jsonb, now()),
  ('premium', 10, 1, 30, 200, '{"rooms":true,"equipments":true,"externalCalendar":true,"advancedExports":true}'::jsonb, now()),
  ('premium_duo', 15, 2, 50, 300, '{"rooms":true,"equipments":true,"externalCalendar":true,"advancedExports":true}'::jsonb, now()),
  ('premium_pro', 999, 10, 100, 1200, '{"rooms":true,"equipments":true,"externalCalendar":true,"advancedExports":true}'::jsonb, now())
ON CONFLICT (plan_code) DO UPDATE
SET max_assets = EXCLUDED.max_assets,
    max_users = EXCLUDED.max_users,
    trial_analysis_quota = EXCLUDED.trial_analysis_quota,
    yearly_analysis_quota = EXCLUDED.yearly_analysis_quota,
    features_json = EXCLUDED.features_json,
    updated_at = now();

INSERT INTO analysis_packs (code, label, credit_amount, price_cents, is_active, eligible_plans_json)
VALUES
  ('pack_50', '+50 documents analysés', 50, 1000, true, '["premium", "premium_duo"]'::jsonb),
  ('pack_100', '+100 documents analysés', 100, 1800, true, '["premium", "premium_duo"]'::jsonb)
ON CONFLICT (code) DO UPDATE
SET label = EXCLUDED.label,
    credit_amount = EXCLUDED.credit_amount,
    price_cents = EXCLUDED.price_cents,
    is_active = EXCLUDED.is_active,
    eligible_plans_json = EXCLUDED.eligible_plans_json,
    updated_at = now();
