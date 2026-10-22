-- verebona:optional-index
-- Migration 0609 (index 3/3) : candidats T1 actifs pas encore réévalués par
-- le contrôle d'identité économique du lot 78A (version `l78a-v1`) —
-- rattrapage automatique borné du stock par le balayage T3. Changer de
-- version de contrôle impose un nouvel index. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_operation_candidates_identity_review_idx
  ON document_operation_candidates (account_id)
  WHERE status = 'ACTIVE' AND established AND COALESCE(t3_detail->>'identityReview', '') <> 'l78a-v1';
