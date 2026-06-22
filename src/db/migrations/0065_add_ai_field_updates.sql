-- Historique des modifications automatiques réalisées par l'IA sur les biens
CREATE TABLE IF NOT EXISTS ai_field_updates (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id      INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  asset_file_id INTEGER REFERENCES asset_files(id) ON DELETE SET NULL,
  field_key     TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_field_updates_account_id_idx ON ai_field_updates(account_id);
CREATE INDEX IF NOT EXISTS ai_field_updates_asset_id_idx ON ai_field_updates(asset_id);
CREATE INDEX IF NOT EXISTS ai_field_updates_created_at_idx ON ai_field_updates(created_at DESC);
