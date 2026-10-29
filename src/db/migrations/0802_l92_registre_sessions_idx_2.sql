-- Migration 0802 (index 2/2) : purge du registre des sessions (lot 92).
-- UNE instruction par fichier (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : sans lui, la purge quotidienne parcourt la table — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_sessions_expires_at_idx
  ON user_sessions (expires_at);
