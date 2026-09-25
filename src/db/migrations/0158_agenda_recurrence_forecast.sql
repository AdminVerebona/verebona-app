-- =============================================================================
-- 0158 — Récurrences d'échéances et occurrences prévisionnelles (T4).
--
-- Une occurrence future n'est créée que si la récurrence est DÉMONTRÉE par
-- les données du compte (mention explicite ou historique cohérent) — jamais
-- par connaissance générale.
--
--   · occurrence_nature : CONFIRMED (date lue, saisie, confirmée) ou
--     FORECAST (calculée à partir d'une récurrence). Indépendante de l'état
--     temporel (à venir / passée) et de manual_status (réalisée / annulée).
--   · date_source : EXPLICIT_DATE | PREDICTED_FROM_RECURRENCE | USER.
--   · series_key : série à laquelle l'occurrence appartient (même objet,
--     même nature d'échéance) ; recurrence_json : règle (mode
--     EXPLICIT_SOURCE / HISTORICAL_PATTERN, fréquence, intervalle, bornes,
--     source, occurrence de référence, date de calcul).
-- =============================================================================
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS occurrence_nature TEXT NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS date_source TEXT;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS series_key TEXT;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS recurrence_json JSONB;

DO $$ BEGIN
  ALTER TABLE agenda_items ADD CONSTRAINT agenda_items_occurrence_nature_check
    CHECK (occurrence_nature IN ('FORECAST', 'CONFIRMED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS agenda_items_series_idx ON agenda_items (account_id, series_key) WHERE series_key IS NOT NULL;
