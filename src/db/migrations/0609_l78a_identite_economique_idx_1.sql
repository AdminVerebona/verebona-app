-- verebona:optional-index
-- Migration 0609 (index 1/3) : journal des contrôles d'identité par compte et
-- statut (BO, diagnostic) — lot 78A. UNE instruction par fichier
-- (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_identity_reviews_account_idx
  ON business_operation_identity_reviews (account_id, status, created_at);
