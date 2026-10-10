-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0295 : couche A de T1 — représentation exhaustive et durable de la
-- source, et contrôle de couverture (lot 34F, ticket « T1 — Garantir une
-- extraction exhaustive, persistée et réexploitable »).
--
--   · `document_source_units` : UNE ligne par unité de la source (bloc de
--     texte, couple libellé / valeur, élément de formulaire, tableau, ligne de
--     tableau, observation visuelle, métadonnée, lacune de pages), contenu
--     INTÉGRAL (jamais tronqué), identifiant stable `source_unit_id`
--     (`page:2:block:14`, `page:5:table:2:row:4`, `page:7:visual:6`…), état de
--     couverture (COVERED, NON_INFORMATIONAL, UNRESOLVED, UNCERTAIN, FAILED).
--     Indépendante de `document_facts` : T3 et les traitements futurs
--     réinterprètent la source SANS rouvrir le fichier.
--   · `document_extraction_coverage` : rapport de complétude courant d'un
--     document (une ligne par fichier) — la somme des états vaut le total
--     (contrainte), état de qualité COMPLETE / COMPLETE_WITH_UNRESOLVED /
--     INCOMPLETE_RETRYABLE / INCOMPLETE_FINAL, anomalies fonctionnelles,
--     reprise ciblée (tentatives, prochaine tentative).
--
-- Remplacement par fichier à chaque analyse (même transaction que les faits).
-- Tables NEUVES : vides à la création ; l'index unique est créé ici (instantané),
-- les index secondaires dans `0295_idx_N` (CONCURRENTLY, optionnels).
--
-- DOCUMENTS HISTORIQUES : aucune réanalyse. La tâche planifiée interne
-- `t1-source-units-backfill` construit progressivement leur couche A à partir
-- des données DÉJÀ persistées (texte intégral, tableaux, observations, faits),
-- sans appel IA. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_source_units (
  id               BIGSERIAL    PRIMARY KEY,
  account_id       INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id          INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  extraction_id    INTEGER      REFERENCES document_extractions(id) ON DELETE SET NULL,
  source_unit_id   TEXT         NOT NULL,
  kind             TEXT         NOT NULL,
  page             INTEGER,
  ordinal          INTEGER      NOT NULL,
  parent_unit_id   TEXT,
  content_text     TEXT,
  label            TEXT,
  value_text       TEXT,
  payload          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  location         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  origin           TEXT         NOT NULL DEFAULT 'PASS_1',
  salient          BOOLEAN      NOT NULL DEFAULT FALSE,
  coverage_status  TEXT         NOT NULL,
  coverage_reason  TEXT,
  fact_count       INTEGER      NOT NULL DEFAULT 0,
  repair_attempts  SMALLINT     NOT NULL DEFAULT 0,
  layer_version    SMALLINT     NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT document_source_units_kind_chk CHECK (kind IN ('DOCUMENT_METADATA', 'TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE', 'TABLE_ROW', 'VISUAL_OBSERVATION', 'VISUAL_SUMMARY', 'PAGE_GAP')),
  CONSTRAINT document_source_units_coverage_chk CHECK (coverage_status IN ('COVERED', 'NON_INFORMATIONAL', 'UNRESOLVED', 'UNCERTAIN', 'FAILED')),
  CONSTRAINT document_source_units_origin_chk CHECK (origin IN ('PASS_1', 'OVERFLOW', 'CHUNK', 'REPAIR', 'BACKFILL'))
);

-- Une unité par identifiant et par document (table neuve : création instantanée).
CREATE UNIQUE INDEX IF NOT EXISTS document_source_units_file_unit_uidx
  ON document_source_units (file_id, source_unit_id);

CREATE TABLE IF NOT EXISTS document_extraction_coverage (
  file_id                  INTEGER      PRIMARY KEY REFERENCES asset_files(id) ON DELETE CASCADE,
  account_id               INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  extraction_id            INTEGER      REFERENCES document_extractions(id) ON DELETE SET NULL,
  total_units              INTEGER      NOT NULL DEFAULT 0,
  covered_units            INTEGER      NOT NULL DEFAULT 0,
  non_informational_units  INTEGER      NOT NULL DEFAULT 0,
  unresolved_units         INTEGER      NOT NULL DEFAULT 0,
  uncertain_units          INTEGER      NOT NULL DEFAULT 0,
  failed_units             INTEGER      NOT NULL DEFAULT 0,
  facts_count              INTEGER      NOT NULL DEFAULT 0,
  dropped_facts_count      INTEGER      NOT NULL DEFAULT 0,
  truncated_sections_count INTEGER      NOT NULL DEFAULT 0,
  batched_sections_count   INTEGER      NOT NULL DEFAULT 0,
  chunk_count              INTEGER      NOT NULL DEFAULT 0,
  repair_pass_count        INTEGER      NOT NULL DEFAULT 0,
  coverage_ratio           NUMERIC(6,4) NOT NULL DEFAULT 1,
  quality_state            TEXT         NOT NULL,
  anomalies                TEXT[]       NOT NULL DEFAULT '{}',
  origin                   TEXT         NOT NULL DEFAULT 'ANALYSIS',
  layer_version            SMALLINT     NOT NULL DEFAULT 1,
  retry_attempts           SMALLINT     NOT NULL DEFAULT 0,
  next_retry_at            TIMESTAMPTZ,
  last_error               TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Règle du ticket : aucune unité silencieusement ignorée.
  CONSTRAINT document_extraction_coverage_sum_chk CHECK (total_units = covered_units + non_informational_units + unresolved_units + uncertain_units + failed_units),
  CONSTRAINT document_extraction_coverage_quality_chk CHECK (quality_state IN ('COMPLETE', 'COMPLETE_WITH_UNRESOLVED', 'INCOMPLETE_RETRYABLE', 'INCOMPLETE_FINAL')),
  CONSTRAINT document_extraction_coverage_origin_chk CHECK (origin IN ('ANALYSIS', 'BACKFILL', 'RETRY'))
);
