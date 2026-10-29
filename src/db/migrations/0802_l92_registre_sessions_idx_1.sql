-- Migration 0802 (index 1/2) : sessions d'un utilisateur (lot 92, écran
-- « Appareils connectés », révocations). UNE instruction par fichier
-- (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : sans lui, la liste des appareils parcourt la table — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_sessions_user_id_idx
  ON user_sessions (user_id, revoked_at);
