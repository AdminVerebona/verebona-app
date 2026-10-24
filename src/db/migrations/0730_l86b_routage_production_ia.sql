-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0730 : état de routage subordonné — promotions mémorisées par
-- opération (lot 86B, CDC Pilotage IA V2 phase P6 : OPT-03, VER-08, ACT-04,
-- R51).
--
-- Une promotion place un modèle de la chaîne CONFIGURÉE d'une opération en
-- tête (jamais un modèle hors de la configuration active / importée), avec
-- justification, origine (`admin` / `system`), preuve et configuration de
-- référence. Réversible (retour à l'ordre configuré), historisée, remise à
-- zéro par le prochain import complet. Une seule promotion active par
-- opération. Configuration IA : exclue de l'export de recette ; restaurée
-- avec la configuration. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_routing_promotions (
  id                BIGSERIAL   PRIMARY KEY,
  environment       TEXT        NOT NULL,
  operation_code    TEXT        NOT NULL,
  treatment         TEXT        NOT NULL,
  model             TEXT        NOT NULL,
  chain_before      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  chain_after       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  origin            TEXT        NOT NULL,
  justification     TEXT        NOT NULL,
  evidence          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  base_import_id    BIGINT      REFERENCES ai_config_imports(id),
  base_version_id   BIGINT,
  base_revision_id  BIGINT,
  created_by        INTEGER,
  created_by_email  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at       TIMESTAMPTZ,
  reverted_by       INTEGER,
  revert_reason     TEXT,
  revert_import_id  BIGINT      REFERENCES ai_config_imports(id),
  CONSTRAINT ai_routing_promotions_origin_check CHECK (origin IN ('admin', 'system')),
  CONSTRAINT ai_routing_promotions_revert_check CHECK (reverted_at IS NULL OR revert_reason IN ('admin', 'import', 'superseded', 'rollback'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_routing_promotions_active_uidx
  ON ai_routing_promotions (environment, operation_code) WHERE reverted_at IS NULL;

COMMENT ON TABLE ai_routing_promotions IS
  'Lot 86B — état de routage subordonné : promotions par opération parmi la chaîne configurée, réversibles, remises à zéro à l’import.';
