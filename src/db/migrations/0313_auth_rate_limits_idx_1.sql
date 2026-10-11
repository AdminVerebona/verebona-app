-- Migration 0313 (index 1/1) : purge du limiteur d'authentification (lot 37).
-- UNE instruction par fichier (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : sans lui, la purge quotidienne parcourt la table — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_rate_limits_updated_at_idx
  ON auth_rate_limits (updated_at);
