-- =============================================================================
-- 0159 — Cycle de vie d'une occurrence d'échéance : prévisionnelle → confirmée.
--
-- Deux dimensions indépendantes :
--   · NATURE (occurrence_nature, 0158) : FORECAST | CONFIRMED ;
--   · ÉTAT temporel / métier, dérivé : à venir / passée (start_date), réalisée
--     / annulée (manual_status, inchangé).
-- Une occurrence confirmée reste CONFIRMED une fois passée ; une prévision
-- jamais confirmée reste identifiable comme telle.
--
-- Confirmation : l'occurrence prévisionnelle ÉVOLUE (même ligne), elle n'est
-- pas doublée. Sa date prévisionnelle initiale, le mode et la source de la
-- confirmation sont conservés ; agenda_occurrence_events trace l'histoire
-- (prévision créée, confirmée, date modifiée, intervention utilisateur,
-- réalisée / annulée).
-- =============================================================================
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS forecast_initial_date DATE;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS confirmation_mode TEXT;   -- SOURCE | USER | DATA
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS confirmation_source JSONB;

CREATE TABLE IF NOT EXISTS agenda_occurrence_events (
  id             SERIAL PRIMARY KEY,
  agenda_item_id INTEGER     NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  account_id     INTEGER     NOT NULL,
  event_type     TEXT        NOT NULL,   -- FORECAST_CREATED | CONFIRMED | DATE_CHANGED | USER_MODIFIED | USER_CONFIRMED | STATUS_CHANGED | EVIDENCE_MATCHED
  actor_user_id  INTEGER,
  detail_json    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agenda_occurrence_events_item_idx ON agenda_occurrence_events (agenda_item_id, created_at);
