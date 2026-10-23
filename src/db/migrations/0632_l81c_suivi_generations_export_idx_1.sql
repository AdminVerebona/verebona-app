-- verebona:optional-index
-- Migration 0632 (index 1/2) : décisions de réconciliation T3 d'un bien, dans
-- l'ordre d'extraction du BO (« Données du compte », diagnostics) — lot 81C.
-- Lecture intégrale par curseur sans tri complet (17 938 décisions et plus).
-- UNE instruction par fichier (`CREATE INDEX CONCURRENTLY` hors transaction).
-- Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reconciliation_decisions_account_asset_created_idx
  ON reconciliation_decisions (account_id, asset_id, created_at DESC, id DESC);
