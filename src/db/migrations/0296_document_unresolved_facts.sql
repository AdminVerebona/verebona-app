-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0296 : faits non résolus de T1 — « incompréhensible ne signifie
-- jamais supprimé » (lot 34F, ticket T1).
--
-- Un élément que le modèle a rendu mais que T1 n'a pas pu intégrer tel quel
-- est CONSERVÉ ici, avec sa charge d'origine complète et les unités de la
-- source qu'il concerne :
--   reason : INVALID_SCHEMA, VALUE_TOO_LONG, NO_EVIDENCE, UNKNOWN_TARGET,
--            UNKNOWN_CANONICAL_KEY, VALUE_NOT_NORMALIZABLE, KEY_NOT_APPLICABLE,
--            FIELD_PRUNED, OBSERVATION_WITHOUT_DESCRIPTION, EMPTY_TABLE ;
--   status : UNRESOLVED (absent des faits), RETAINED (présent, requalifié :
--            générique, cible neutralisée), RECOVERED (retrouvé par la
--            réparation ciblée).
-- Remplacement par fichier à chaque analyse (même transaction que les faits).
-- Table NEUVE : index secondaire dans `0296_idx_1` (CONCURRENTLY, optionnel).
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS document_unresolved_facts (
  id                BIGSERIAL    PRIMARY KEY,
  account_id        INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_id           INTEGER      NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  extraction_id     INTEGER      REFERENCES document_extractions(id) ON DELETE SET NULL,
  reason            TEXT         NOT NULL,
  status            TEXT         NOT NULL DEFAULT 'UNRESOLVED',
  source_unit_ids   TEXT[]       NOT NULL DEFAULT '{}',
  raw_key           TEXT,
  canonical_key     TEXT,
  raw_value         TEXT,
  original_payload  JSONB,
  pass              TEXT         NOT NULL DEFAULT 'PASS_1',
  detail            TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT document_unresolved_facts_status_chk CHECK (status IN ('UNRESOLVED', 'RETAINED', 'RECOVERED'))
);
