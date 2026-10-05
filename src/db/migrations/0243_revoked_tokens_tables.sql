-- APP-PERF-16 : tables de révocation de session créées par la chaîne de
-- migrations (étape de déploiement), et non plus à la première requête par
-- `ensureRevokedTokensTable()` — DDL hors chemin de requête. Même définition
-- qu'avant, idempotente : sans effet là où les tables existent déjà.
-- Expand seulement : la version précédente continue de fonctionner.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  id         SERIAL PRIMARY KEY,
  token_hash TEXT        NOT NULL UNIQUE,
  user_id    INTEGER     NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS revoked_tokens_token_hash_idx ON revoked_tokens (token_hash);
CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx ON revoked_tokens (expires_at);
CREATE TABLE IF NOT EXISTS user_session_revocations (
  user_id        INTEGER     PRIMARY KEY,
  revoked_before TIMESTAMPTZ NOT NULL,
  reason         TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
