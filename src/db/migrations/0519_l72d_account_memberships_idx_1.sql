-- verebona:optional-index
-- Migration 0519 (index 1/1) : dernier espace sélectionné par utilisateur
-- (lot 72D, ouverture de session). UNE instruction par fichier
-- (CONCURRENTLY hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_memberships_user_last_selected_idx
  ON account_memberships (user_id, last_selected_at DESC) WHERE status = 'active';
