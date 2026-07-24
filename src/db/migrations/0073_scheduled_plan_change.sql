-- ============================================================================
-- 0073 — Changement d'offre et de periodicite programme (CDC tarification §10)
--
-- Les changements ne prennent jamais effet immediatement :
--   - mensuel vers annuel : a la prochaine echeance mensuelle ;
--   - annuel vers mensuel : a la fin de la periode annuelle payee.
-- Aucun prorata, aucun remboursement. L'intention est donc stockee ici, puis
-- appliquee au renouvellement.
-- ============================================================================

ALTER TABLE account_subscriptions ADD COLUMN IF NOT EXISTS scheduled_plan_code TEXT;
ALTER TABLE account_subscriptions ADD COLUMN IF NOT EXISTS scheduled_billing_period TEXT;
ALTER TABLE account_subscriptions ADD COLUMN IF NOT EXISTS scheduled_change_at TIMESTAMPTZ;

COMMENT ON COLUMN account_subscriptions.scheduled_plan_code IS
  'Offre qui prendra effet au prochain renouvellement (NULL si aucun changement programme)';
COMMENT ON COLUMN account_subscriptions.scheduled_billing_period IS
  'monthly | yearly — periodicite qui prendra effet au prochain renouvellement';
COMMENT ON COLUMN account_subscriptions.scheduled_change_at IS
  'Date prevue de prise d''effet, correspondant a la fin de la periode en cours';

CREATE INDEX IF NOT EXISTS account_subscriptions_scheduled_idx
  ON account_subscriptions (scheduled_change_at)
  WHERE scheduled_plan_code IS NOT NULL;
