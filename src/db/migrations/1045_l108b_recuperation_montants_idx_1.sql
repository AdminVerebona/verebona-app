-- verebona:optional-index
-- Migration 1045 (index 1) : états de récupération des montants d'un compte
-- (lecture du TCO par compte et statut, lot 108B). Fichier à UNE instruction
-- (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_amount_recoveries_account_idx
  ON document_amount_recoveries (account_id, status);
