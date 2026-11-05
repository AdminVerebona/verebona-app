-- verebona:optional-index
-- Migration 1160 (index 1/1) : jetons d'import par utilisateur et session (rotation, révocation) — lot 110A.
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mobile_share_import_grants_user_sid_idx
  ON mobile_share_import_grants (user_id, session_sid);
