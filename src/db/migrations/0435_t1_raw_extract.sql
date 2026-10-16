-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0435 : T1 — extract BRUT déterministe du document et états séparés
-- des trois phases (lot 61, ticket « [P1] T1 — Corriger le blocage Gemini et
-- garantir extraction exhaustive, structuration et persistance BDD », §3, §6).
--
-- POURQUOI UNE TABLE NEUVE (et pas `document_extractions`)
--   `document_extractions` est la représentation de CONNAISSANCE, écrite dans
--   la même transaction que les faits, APRÈS la structuration par le modèle :
--   un échec de Gemini (incident fileId=98) ou de cette transaction ne laissait
--   AUCUN extract. Cette table a un autre cycle de vie :
--     · écrite AVANT l'appel au modèle, par une lecture DÉTERMINISTE du fichier
--       (couche texte PDF page par page, texte brut) — jamais résumée ni
--       reformulée, pages marquées « --- page N --- » ;
--     · conservée quel que soit le sort de la structuration et de la
--       persistance ; réutilisée telle quelle à la reprise (même objet de
--       stockage `source_ref`, même version d'extracteur) : ni nouveau
--       téléchargement, ni ré-extraction ;
--     · porte les états SÉPARÉS extraction / structuration / persistance du
--       dernier passage (BO › Exécutions IA, reprise).
--   Pages sans couche texte (scans, images) : listées explicitement
--   (`pages_without_text`), OCR délégué au modèle multimodal et contrôlé par la
--   vérification de couverture existante (lot 49B / 54G) ; jamais présentées
--   comme extraites. Troncature (bornes de pages / caractères) : statut
--   TRUNCATED, `truncated`, `truncation_reason` — jamais silencieuse, jamais
--   présentée comme complète.
--
-- Une ligne par fichier (UPSERT). Table NEUVE : vide à la création, contrainte
-- unique créée ici (instantané) ; index secondaire dans `0435_idx_1`
-- (CONCURRENTLY, optionnel). Aucune donnée existante modifiée. Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS document_raw_extracts (code tolérant :
-- table absente → T1 inchangé, extract brut non écrit).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_raw_extracts (
  id                     BIGSERIAL    PRIMARY KEY,
  account_id             INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id                INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  source_ref             TEXT,
  source_sha256          TEXT,
  source_bytes           BIGINT,
  mime_type              TEXT,
  method                 TEXT         NOT NULL,
  extractor_version      SMALLINT     NOT NULL DEFAULT 1,
  extraction_status      TEXT         NOT NULL,
  page_count             INTEGER,
  pages_with_text        INTEGER      NOT NULL DEFAULT 0,
  pages_without_text     INTEGER[]    NOT NULL DEFAULT '{}',
  truncated              BOOLEAN      NOT NULL DEFAULT FALSE,
  truncation_reason      TEXT,
  full_text              TEXT,
  full_text_chars        INTEGER      NOT NULL DEFAULT 0,
  full_text_sha256       TEXT,
  pages                  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  extraction_error       TEXT,
  extraction_ms          INTEGER,
  extracted_at           TIMESTAMPTZ,
  reuse_count            INTEGER      NOT NULL DEFAULT 0,
  structuring_status     TEXT,
  structuring_error_code TEXT,
  structuring_error      TEXT,
  structuring_at         TIMESTAMPTZ,
  persistence_status     TEXT,
  persistence_error      TEXT,
  persistence_at         TIMESTAMPTZ,
  last_job_id            INTEGER,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT document_raw_extracts_method_chk CHECK (method IN ('PDF_TEXT_LAYER', 'PLAIN_TEXT', 'NONE')),
  CONSTRAINT document_raw_extracts_extraction_chk CHECK (extraction_status IN ('COMPLETE', 'PARTIAL_OCR_REQUIRED', 'OCR_REQUIRED', 'TRUNCATED', 'FAILED', 'NOT_SUPPORTED')),
  CONSTRAINT document_raw_extracts_structuring_chk CHECK (structuring_status IS NULL OR structuring_status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT document_raw_extracts_persistence_chk CHECK (persistence_status IS NULL OR persistence_status IN ('SUCCEEDED', 'PARTIAL', 'FAILED'))
);

-- Une ligne par fichier (table neuve : création instantanée).
CREATE UNIQUE INDEX IF NOT EXISTS document_raw_extracts_file_uidx
  ON document_raw_extracts (file_id);

COMMENT ON TABLE document_raw_extracts IS
  'Lot 61 : extract brut déterministe d''un document (couche texte PDF par page, texte brut), écrit avant le modèle et conservé quel que soit le sort de la structuration ; états séparés extraction / structuration / persistance du dernier passage T1.';
