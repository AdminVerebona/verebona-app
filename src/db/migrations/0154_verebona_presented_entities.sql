-- =============================================================================
-- 0154 — Entités présentées dans un fil de l'assistant (mémoire conversationnelle).
--
-- « Ouvre le deuxième » doit désigner le deuxième élément RÉELLEMENT affiché,
-- même si une nouvelle requête les rendrait dans un autre ordre : l'ordre de
-- présentation est donc enregistré, par message.
--
-- Rattachée au fil (purgée avec lui : effacement, rétention). Jamais une
-- autorisation : toute entité référencée est re-vérifiée avant usage.
-- =============================================================================
CREATE TABLE IF NOT EXISTS verebona_presented_entities (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER     NOT NULL,
  message_id      INTEGER     NOT NULL,
  position        INTEGER     NOT NULL,
  entity_type     TEXT        NOT NULL,  -- asset | document | agenda_item
  entity_id       INTEGER     NOT NULL,
  label           TEXT,
  presented_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_presented_entities_conv_idx
  ON verebona_presented_entities (conversation_id, message_id, position);
