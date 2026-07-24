-- ============================================================================
-- 0074 — Suivi analytique du parcours de souscription (CDC tarification §17)
--
-- Une ligne par evenement du parcours, de la creation du compte a la
-- conversion. Sert au calcul des indicateurs d'activation et de conversion.
-- ============================================================================

CREATE TABLE IF NOT EXISTS funnel_events (
  id           SERIAL PRIMARY KEY,
  account_id   INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,
  plan_code    TEXT,
  billing_period TEXT,
  metadata     JSONB,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS funnel_events_account_idx ON funnel_events (account_id);
CREATE INDEX IF NOT EXISTS funnel_events_type_idx    ON funnel_events (event_type);
CREATE INDEX IF NOT EXISTS funnel_events_date_idx    ON funnel_events (occurred_at);

-- Certains evenements ne doivent etre comptes qu'une fois par compte
-- (premier bien, premier document, premiere question...). L'unicite est
-- assuree ici plutot que par la logique applicative.
CREATE UNIQUE INDEX IF NOT EXISTS funnel_events_once_per_account_idx
  ON funnel_events (account_id, event_type)
  WHERE event_type IN (
    'account_created',
    'trial_started',
    'first_asset_added',
    'first_document_added',
    'first_question_asked',
    'first_export_generated'
  );

COMMENT ON TABLE funnel_events IS
  'Evenements du parcours de souscription (CDC tarification §17). Aucune donnee personnelle au-dela des identifiants.';
