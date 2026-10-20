-- verebona:optional-index
-- Migration 0520 (index 1/1) : un compte porte au plus un Duo (lot 72D).
-- UNE instruction par fichier (CONCURRENTLY hors transaction). Idempotente.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS duo_accounts_account_id_unique_idx
  ON duo_accounts (account_id) WHERE account_id IS NOT NULL;
