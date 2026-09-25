-- 0162 — Tableaux extraits par T1, structure ligne/colonne conservée.
--
-- La transcription garde le texte d'un tableau, pas ses relations. Chaque
-- tableau est persisté avec ses colonnes ordonnées et chaque cellule avec sa
-- ligne, sa colonne, ses en-têtes et sa page. Une cellule vide est une ligne
-- à `is_empty = true` : rien n'est décalé. Une nouvelle analyse fait passer
-- les tableaux précédents en `superseded` (comme les faits).

CREATE TABLE IF NOT EXISTS document_tables (
  id                BIGSERIAL PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id           INTEGER NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  extraction_id     INTEGER NOT NULL REFERENCES document_extractions(id) ON DELETE CASCADE,
  table_index       INTEGER NOT NULL,
  title             TEXT,
  page_start        INTEGER,
  page_end          INTEGER,
  column_count      INTEGER NOT NULL,
  row_count         INTEGER NOT NULL,
  columns           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ header, path[] }] dans l'ordre
  confidence        TEXT NOT NULL DEFAULT 'certain',
  uncertain         BOOLEAN NOT NULL DEFAULT FALSE,
  issues            JSONB NOT NULL DEFAULT '[]'::jsonb,   -- incertitudes de structure
  source_version    INTEGER,
  provider          TEXT,
  model             TEXT,
  prompt_version    TEXT,
  status            TEXT NOT NULL DEFAULT 'active',       -- active | superseded
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS document_tables_file_idx ON document_tables (file_id, status);
CREATE INDEX IF NOT EXISTS document_tables_account_idx ON document_tables (account_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS document_table_cells (
  id                BIGSERIAL PRIMARY KEY,
  table_id          BIGINT  NOT NULL REFERENCES document_tables(id) ON DELETE CASCADE,
  account_id        INTEGER NOT NULL,
  file_id           INTEGER NOT NULL,
  row_index         INTEGER NOT NULL,
  column_index      INTEGER NOT NULL,
  row_header        TEXT,
  column_header     TEXT,
  column_path       JSONB NOT NULL DEFAULT '[]'::jsonb,
  value_text        TEXT,                                 -- NULL si la cellule est vide
  normalized_value  TEXT,
  value_type        TEXT,
  is_empty          BOOLEAN NOT NULL DEFAULT FALSE,
  colspan           INTEGER NOT NULL DEFAULT 1,
  rowspan           INTEGER NOT NULL DEFAULT 1,
  page              INTEGER,
  confidence        TEXT NOT NULL DEFAULT 'certain',
  CONSTRAINT document_table_cells_pos_uidx UNIQUE (table_id, row_index, column_index),
  CONSTRAINT document_table_cells_empty_ck CHECK (is_empty = (value_text IS NULL))
);
CREATE INDEX IF NOT EXISTS document_table_cells_account_idx ON document_table_cells (account_id);
CREATE INDEX IF NOT EXISTS document_table_cells_row_idx ON document_table_cells (table_id, row_index);
