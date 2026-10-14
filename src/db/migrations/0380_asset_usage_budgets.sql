-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0380 : forfaits d'usage d'un bien (lot 54D — TCO §3.5).
--
--   asset_usage_budgets : budgets ESTIMÉS (carburant, recharge, péages, autre)
--   saisis par l'utilisateur autorisé (Premium / Premium Duo). Ce ne sont
--   JAMAIS des coûts réalisés ni des Opérations (aucune ligne
--   business_operations) : le TCO les présente à part.
--
--   Montant en unités mineures de la devise, périodicité, validité. Le bien
--   porte le compte : `account_id` suit le bien lors d'un transfert
--   (`ASSET_SCOPED_TABLES`). Aucune suppression au changement d'offre : un
--   compte Standard ne les voit plus, il les retrouve en repassant Premium.
--
-- Table neuve (index dans 0380_..._idx_1, CONCURRENTLY). Idempotente. Non
-- déclarée dans Drizzle (lecture SQL directe, comme 0371). Retour arrière :
-- DROP TABLE IF EXISTS asset_usage_budgets.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS asset_usage_budgets (
  id           BIGSERIAL    PRIMARY KEY,
  account_id   INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id     INTEGER      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  category     TEXT         NOT NULL,
  label        TEXT,
  amount_minor BIGINT       NOT NULL,
  currency     CHAR(3)      NOT NULL DEFAULT 'EUR',
  periodicity  TEXT         NOT NULL,
  valid_from   DATE,
  valid_to     DATE,
  created_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  updated_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT asset_usage_budgets_category_chk CHECK (category IN ('FUEL', 'CHARGING', 'TOLLS', 'OTHER')),
  CONSTRAINT asset_usage_budgets_periodicity_chk CHECK (periodicity IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  CONSTRAINT asset_usage_budgets_amount_chk CHECK (amount_minor >= 0),
  CONSTRAINT asset_usage_budgets_currency_chk CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'XXX'),
  CONSTRAINT asset_usage_budgets_validity_chk CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT asset_usage_budgets_label_chk CHECK (label IS NULL OR length(label) <= 120)
);

COMMENT ON TABLE asset_usage_budgets IS
  'Lot 54D : forfaits d''usage (budgets estimés) d''un bien — jamais des coûts réalisés ni des Opérations ; présentés à part dans le TCO.';

-- Lot 54B (SEC-P0) : garde d'isolation — un forfait ne relie jamais un compte
-- au bien d'un autre compte (même fonction que les liens d'Opérations, 0373).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'account_isolation_link_guard') THEN
    DROP TRIGGER IF EXISTS asset_usage_budgets_isolation_guard ON asset_usage_budgets;
    CREATE TRIGGER asset_usage_budgets_isolation_guard
      BEFORE INSERT OR UPDATE OF asset_id ON asset_usage_budgets
      FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('account', 'account_id', 'asset', 'asset_id');
  END IF;
END $$;
