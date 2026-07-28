-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0102 : Provenance des valeurs — table field_evidence
-- CDC Verebona §5.4.2
--
-- Constat : ai_field_updates conserve une ancienne et une nouvelle valeur, mais
-- pas la chaîne de preuve (source exacte, extrait, modèle, version de prompt,
-- confiance, autorité). Sans cette table, le critère d'acceptation n°12 est
-- inatteignable.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS field_evidence (
  id                 SERIAL PRIMARY KEY,
  account_id         INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id           INTEGER     NOT NULL REFERENCES assets(id)   ON DELETE CASCADE,
  field_key          TEXT        NOT NULL,
  value_json         JSONB       NOT NULL,
  normalized_value   TEXT,
  source_type        TEXT        NOT NULL,
  source_id          INTEGER     NOT NULL,
  source_version     INTEGER,
  -- page, section, passage ou sélecteur (CDC §5.4.2)
  source_location    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  evidence_excerpt   TEXT        NOT NULL,
  document_type      TEXT,
  document_date      TIMESTAMPTZ,
  provider           TEXT,
  model              TEXT,
  prompt_version     TEXT,
  confidence         TEXT        NOT NULL,
  authority_score    INTEGER     NOT NULL DEFAULT 0,
  extracted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT        NOT NULL DEFAULT 'active',
  operation_trace_id UUID,
  -- Empreinte d'unicité : une même preuve ne doit pas être créée deux fois (§5.7)
  fingerprint        TEXT        NOT NULL,

  CONSTRAINT field_evidence_confidence_check CHECK (confidence IN ('certain', 'probable', 'conflictual')),
  CONSTRAINT field_evidence_status_check     CHECK (status     IN ('active', 'superseded', 'rejected', 'conflict')),
  CONSTRAINT field_evidence_source_check     CHECK (source_type IN ('document', 'web_link', 'agenda', 'equipment', 'supplier', 'user_input'))
);

CREATE UNIQUE INDEX IF NOT EXISTS field_evidence_fingerprint_uidx ON field_evidence(fingerprint);
CREATE INDEX IF NOT EXISTS field_evidence_account_idx      ON field_evidence(account_id);
CREATE INDEX IF NOT EXISTS field_evidence_asset_field_idx  ON field_evidence(asset_id, field_key);
CREATE INDEX IF NOT EXISTS field_evidence_status_idx       ON field_evidence(status);
CREATE INDEX IF NOT EXISTS field_evidence_source_idx       ON field_evidence(source_type, source_id);
CREATE INDEX IF NOT EXISTS field_evidence_active_lookup_idx
  ON field_evidence(asset_id, field_key, authority_score DESC) WHERE status = 'active';
