-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0180 — Alimentation de la table `invoices` depuis Stripe.
--
-- CDC Back-Office V1 : DOV-001/DOV-002 (CA encaissé), SUB-001 (paiements
-- échoués), SUB-009/SUB-010 (historique des paiements : date, montant,
-- statut, offre associée). Audit BO §2.6 : la table existait mais n'était
-- alimentée par aucun code.
--
-- Colonnes ajoutées : l'offre et le prix facturés (SUB-009 — jusqu'ici
-- déduits a posteriori de `subscription_history`), le motif de facturation,
-- la période couverte, la date du dernier échec et le montant remboursé.
-- `amount` reste le montant ENCAISSÉ (facture payée) ou dû (sinon), en
-- centimes, avant frais Stripe (DOV-002).
--
-- Idempotente : peut être rejouée sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_price_id        TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS plan_code              TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_period         TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_reason         TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_start_at        TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_end_at          TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_payment_failed_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_refunded        INTEGER NOT NULL DEFAULT 0;

-- Lectures BO : fiche compte (par compte), dashboard CA (par date d'encaissement).
CREATE INDEX IF NOT EXISTS invoices_account_id_idx ON invoices (account_id);
CREATE INDEX IF NOT EXISTS invoices_paid_at_idx ON invoices (paid_at);
CREATE INDEX IF NOT EXISTS invoices_stripe_subscription_id_idx ON invoices (stripe_subscription_id);

COMMENT ON COLUMN invoices.status IS
  'Statut local : draft | open | payment_failed | uncollectible | paid | void. '
  'payment_failed = facture Stripe « open » dont une tentative a échoué (SUB-010).';
COMMENT ON COLUMN invoices.amount IS
  'Centimes. Facture payée : montant encaissé (amount_paid) ; sinon montant dû (amount_due).';
