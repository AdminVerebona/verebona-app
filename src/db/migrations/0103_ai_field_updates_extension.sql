-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0103 : Extension de ai_field_updates — CDC §5.4.3
-- Rattache chaque modification automatique à sa preuve et à sa décision.
-- Colonnes nullables : l'historique antérieur n'est pas réécrit (CDC §9.7).
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS evidence_id    INTEGER REFERENCES field_evidence(id) ON DELETE SET NULL;
ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS decision_type  TEXT;
ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS reason_code    TEXT;
ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS provider       TEXT;
ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS model          TEXT;
ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS confidence     TEXT;
ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS reverted_at    TIMESTAMPTZ;
ALTER TABLE ai_field_updates ADD COLUMN IF NOT EXISTS reverted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_field_updates_evidence_idx  ON ai_field_updates(evidence_id);
CREATE INDEX IF NOT EXISTS ai_field_updates_asset_field_idx ON ai_field_updates(asset_id, field_key);
CREATE INDEX IF NOT EXISTS ai_field_updates_reverted_idx  ON ai_field_updates(reverted_at);
