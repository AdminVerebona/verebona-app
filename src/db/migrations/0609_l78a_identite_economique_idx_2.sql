-- verebona:optional-index
-- Migration 0609 (index 2/3) : journal des contrôles d'identité par Opération
-- (détail BO, export de diagnostic) — lot 78A. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_identity_reviews_operation_idx
  ON business_operation_identity_reviews (operation_id, created_at);
