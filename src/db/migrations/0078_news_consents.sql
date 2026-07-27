-- ============================================================================
-- 0078 — Consentement aux actualités Verebona (CDC Notifications §7.8 / §19.5)
--
-- Les actualités promotionnelles ne sont JAMAIS activées par défaut ni déduites
-- de l'autorisation push. Un consentement explicite et distinct est requis, sa
-- preuve (date, source, version) est conservée, et son retrait est immédiat.
--
-- Un enregistrement par utilisateur : `consented` porte l'état courant ;
-- `consented_at` / `revoked_at` et `source` / `version` constituent la preuve.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS news_consents (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consented     BOOLEAN NOT NULL DEFAULT FALSE,
  source        TEXT,                  -- ex. 'mon-compte/notifications', 'onboarding'
  version       TEXT,                  -- version du texte de consentement présenté
  consented_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT news_consents_user_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS news_consents_user_idx ON news_consents (user_id);
CREATE INDEX IF NOT EXISTS news_consents_consented_idx ON news_consents (consented);

COMMENT ON TABLE news_consents IS
  'Consentement explicite aux actualités (CDC §7.8/§19.5). Jamais activé par défaut ; retrait immédiat ; preuve conservée.';
