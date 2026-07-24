-- ============================================================================
-- 0072 — Tarification V2 (mensuel/annuel) + essai 7 jours
-- CDC : 3 offres x 2 periodicites = 6 prix Stripe, essai unique de 7 jours
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. subscription_plans : prix mensuel reel + 2 Price IDs Stripe
--    (stripe_price_id et monthly_equivalent_cents restent pour compatibilite,
--     ils seront retires dans une migration ulterieure)
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id_monthly TEXT;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id_yearly TEXT;

-- ---------------------------------------------------------------------------
-- 2. plan_limits : quota de documents (CDC 30 / 150 / 225)
-- ---------------------------------------------------------------------------
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS max_documents INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. account_subscriptions : periodicite + essai consomme
-- ---------------------------------------------------------------------------
ALTER TABLE account_subscriptions ADD COLUMN IF NOT EXISTS billing_period TEXT;
ALTER TABLE account_subscriptions ADD COLUMN IF NOT EXISTS trial_consumed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN account_subscriptions.billing_period IS 'monthly | yearly — NULL pendant l''essai (aucun abonnement Stripe)';

-- Les abonnements existants sont annuels (modele precedent)
UPDATE account_subscriptions
SET billing_period = 'yearly'
WHERE billing_period IS NULL
  AND stripe_subscription_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. trial_grants : unicite de l'essai (anti-fraude)
--    Table dediee : survit a la suppression/recreation d'un compte.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trial_grants (
  id                SERIAL PRIMARY KEY,
  email_normalized  TEXT NOT NULL,
  account_id        INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  converted_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS trial_grants_email_uidx ON trial_grants (email_normalized);
CREATE INDEX IF NOT EXISTS trial_grants_account_id_idx  ON trial_grants (account_id);

COMMENT ON TABLE  trial_grants IS 'Un essai gratuit par adresse email (normalisee). Conserve apres suppression de compte.';
COMMENT ON COLUMN trial_grants.email_normalized IS 'Email en minuscules, trim ; sert de cle d''unicite anti-fraude';

-- ---------------------------------------------------------------------------
-- 5. Grille tarifaire CDC
--    Standard 2,90/29 · Premium 5,90/59 · Premium Duo 8,90/89 (TTC, en cents)
--    Les Price IDs Stripe sont renseignes ensuite (script de sync dedie).
-- ---------------------------------------------------------------------------
UPDATE subscription_plans SET monthly_price_cents = 290,  yearly_price_cents = 2900 WHERE code = 'standard';
UPDATE subscription_plans SET monthly_price_cents = 590,  yearly_price_cents = 5900 WHERE code = 'premium';
UPDATE subscription_plans SET monthly_price_cents = 890,  yearly_price_cents = 8900 WHERE code = 'premium_duo';

-- Pro : visible mais non souscriptible (« Bientot »)
UPDATE subscription_plans SET is_subscribable = FALSE WHERE code = 'premium_pro';

-- ---------------------------------------------------------------------------
-- 6. Quotas CDC (biens / documents / utilisateurs)
-- ---------------------------------------------------------------------------
UPDATE plan_limits SET max_assets = 2,  max_documents = 30,  max_users = 1 WHERE plan_code = 'standard';
UPDATE plan_limits SET max_assets = 10, max_documents = 150, max_users = 1 WHERE plan_code = 'premium';
UPDATE plan_limits SET max_assets = 15, max_documents = 225, max_users = 2 WHERE plan_code = 'premium_duo';
