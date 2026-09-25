-- =============================================================================
-- 0153 — Traçabilité du parcours de clarification de l'assistant (§20).
--
-- Une ligne par étape : création (demande initiale, raison de l'ambiguïté,
-- candidats), choix (valide / invalide), réponse non reconnue, expiration,
-- candidat devenu invalide, reprise réussie ou en échec, repli après
-- épuisement des tentatives, abandon.
--
-- Rattachée au fil : purgée avec la conversation (effacement manuel,
-- rétention), comme le reste de la mémoire conversationnelle.
-- =============================================================================
CREATE TABLE IF NOT EXISTS verebona_clarification_events (
  id               SERIAL PRIMARY KEY,
  clarification_id TEXT        NOT NULL,
  conversation_id  INTEGER,
  account_id       INTEGER     NOT NULL,
  user_id          INTEGER,
  event_type       TEXT        NOT NULL,
  detail_json      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_clarification_events_clar_idx
  ON verebona_clarification_events (clarification_id, created_at);
CREATE INDEX IF NOT EXISTS verebona_clarification_events_conv_idx
  ON verebona_clarification_events (conversation_id);
