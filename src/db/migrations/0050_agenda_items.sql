-- Migration: Agenda CDC V3 — agenda_items + junction tables + conflicts + accounts calendar columns
-- Phase 1 of plan Agenda Verebona CDC V3

-- 1. agenda_items canonical table
CREATE TABLE IF NOT EXISTS agenda_items (
  id                    SERIAL PRIMARY KEY,
  public_id             UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  account_id            INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  start_date            DATE,
  start_time            TIME,
  end_date              DATE,
  end_time              TIME,
  manual_status         TEXT CHECK (manual_status IS NULL OR manual_status IN ('realise', 'annule')),
  is_automatic          BOOLEAN NOT NULL DEFAULT false,
  is_automatic_modified BOOLEAN NOT NULL DEFAULT false,
  requires_qualification BOOLEAN NOT NULL DEFAULT false,
  origin_type           TEXT NOT NULL DEFAULT 'manual'
                        CHECK (origin_type IN (
                          'manual',
                          'asset_field',
                          'qualified_document',
                          'deduced_rule',
                          'legacy_event_migration',
                          'legacy_deadline_migration'
                        )),
  origin_ref_type       TEXT,
  origin_ref_id         INTEGER,
  origin_field_key      TEXT,
  created_at            TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at            TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE INDEX IF NOT EXISTS agenda_items_account_id_idx    ON agenda_items (account_id);
CREATE INDEX IF NOT EXISTS agenda_items_start_date_idx    ON agenda_items (start_date);
CREATE INDEX IF NOT EXISTS agenda_items_manual_status_idx ON agenda_items (manual_status);
CREATE INDEX IF NOT EXISTS agenda_items_origin_type_idx   ON agenda_items (origin_type);
CREATE INDEX IF NOT EXISTS agenda_items_title_gin         ON agenda_items USING gin(to_tsvector('french', title));
CREATE INDEX IF NOT EXISTS agenda_items_desc_gin          ON agenda_items USING gin(to_tsvector('french', coalesce(description, '')));

-- 2. Junction tables
CREATE TABLE IF NOT EXISTS agenda_asset_links (
  id             SERIAL PRIMARY KEY,
  agenda_item_id INTEGER NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  asset_id       INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  UNIQUE(agenda_item_id, asset_id)
);
CREATE INDEX IF NOT EXISTS agenda_asset_links_agenda_item_id_idx ON agenda_asset_links (agenda_item_id);
CREATE INDEX IF NOT EXISTS agenda_asset_links_asset_id_idx       ON agenda_asset_links (asset_id);

CREATE TABLE IF NOT EXISTS agenda_file_links (
  id             SERIAL PRIMARY KEY,
  agenda_item_id INTEGER NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  asset_file_id  INTEGER NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  UNIQUE(agenda_item_id, asset_file_id)
);
CREATE INDEX IF NOT EXISTS agenda_file_links_agenda_item_id_idx ON agenda_file_links (agenda_item_id);

CREATE TABLE IF NOT EXISTS agenda_room_links (
  id               SERIAL PRIMARY KEY,
  agenda_item_id   INTEGER NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  substructure_id  INTEGER NOT NULL REFERENCES substructures(id) ON DELETE CASCADE,
  UNIQUE(agenda_item_id, substructure_id)
);
CREATE INDEX IF NOT EXISTS agenda_room_links_agenda_item_id_idx ON agenda_room_links (agenda_item_id);

CREATE TABLE IF NOT EXISTS agenda_equipment_links (
  id             SERIAL PRIMARY KEY,
  agenda_item_id INTEGER NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  equipment_id   INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
  UNIQUE(agenda_item_id, equipment_id)
);
CREATE INDEX IF NOT EXISTS agenda_equipment_links_agenda_item_id_idx ON agenda_equipment_links (agenda_item_id);

-- 3. Conflict table
CREATE TABLE IF NOT EXISTS agenda_data_conflicts (
  id                     SERIAL PRIMARY KEY,
  account_id             INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agenda_item_id         INTEGER REFERENCES agenda_items(id) ON DELETE SET NULL,
  result_agenda_item_id  INTEGER REFERENCES agenda_items(id) ON DELETE SET NULL,
  conflict_type          TEXT NOT NULL
                         CHECK (conflict_type IN ('date_mismatch', 'distinct_data_unqualified')),
  field_key              TEXT,
  source_type_a          TEXT NOT NULL,
  source_ref_id_a        INTEGER,
  value_date_a           DATE,
  source_type_b          TEXT NOT NULL,
  source_ref_id_b        INTEGER,
  value_date_b           DATE,
  current_decision       TEXT NOT NULL DEFAULT 'pending'
                         CHECK (current_decision IN (
                           'pending',
                           'kept_existing',
                           'kept_new',
                           'declared_distinct',
                           'skipped'
                         )),
  requires_qualification BOOLEAN NOT NULL DEFAULT false,
  note                   TEXT,
  resolved_at            TEXT,
  resolved_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL DEFAULT NOW()::TEXT,
  updated_at             TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE INDEX IF NOT EXISTS agenda_data_conflicts_account_id_idx       ON agenda_data_conflicts (account_id);
CREATE INDEX IF NOT EXISTS agenda_data_conflicts_current_decision_idx ON agenda_data_conflicts (current_decision);
CREATE INDEX IF NOT EXISTS agenda_data_conflicts_agenda_item_id_idx   ON agenda_data_conflicts (agenda_item_id);

-- 4. Calendar token columns on accounts
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS calendar_share_token           TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS calendar_share_token_active    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS calendar_share_token_created_at TEXT;
