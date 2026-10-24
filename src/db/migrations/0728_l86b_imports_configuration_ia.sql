-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0728 : journal des imports de la configuration IA globale (lot 86B,
-- CDC Pilotage IA V2 phase P6 : VER-04, VER-06, VER-07, RUN-05, R14, R15, R68 ;
-- décision PO 07 — import manuel COMPLET et ATOMIQUE, historisé, retour à la
-- configuration antérieure).
--
-- Une ligne par import CONFIRMÉ (appliqué ou refusé) et par retour arrière :
--   · `applied`  : la version créée et activée, la configuration remplacée
--                  (version / révision antérieures), le texte EXACT du fichier
--                  et sa signature d'intégrité, le résumé de la
--                  prévisualisation confirmée ;
--   · `refused`  : diagnostic des contrôles bloquants (aucun contenu, aucune
--                  écriture de configuration : l'active est inchangée).
-- L'ancien `ai_config_packages` (format `ai-config-package-v1`) reste en base,
-- INERTE (aucune lecture, aucune écriture depuis le lot 86B ; non supprimé).
-- Configuration IA : exclue de l'export de recette (motif dans
-- recette-catalog.ts) ; restaurée AVEC les versions (cohérence des liens).
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_config_imports (
  id                     BIGSERIAL   PRIMARY KEY,
  environment            TEXT        NOT NULL,
  action                 TEXT        NOT NULL,
  status                 TEXT        NOT NULL,
  format_version         TEXT,
  file_signature         TEXT,
  configuration_sha256   TEXT,
  file_content           TEXT,
  source_environment     TEXT,
  source_export_id       TEXT,
  source_version_number  INTEGER,
  source_revision_number INTEGER,
  source_exported_at     TIMESTAMPTZ,
  source_app_version     TEXT,
  previous_version_id    BIGINT,
  previous_revision_id   BIGINT,
  new_version_id         BIGINT,
  new_revision_id        BIGINT,
  rollback_of            BIGINT      REFERENCES ai_config_imports(id),
  rolled_back_at         TIMESTAMPTZ,
  rolled_back_by         INTEGER,
  summary                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  diagnostics            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by             INTEGER,
  created_by_email       TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_config_imports_action_check CHECK (action IN ('import', 'rollback')),
  CONSTRAINT ai_config_imports_status_check CHECK (status IN ('applied', 'refused')),
  CONSTRAINT ai_config_imports_applied_check CHECK (status <> 'applied' OR new_version_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ai_config_imports_env_idx ON ai_config_imports (environment, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_config_imports_signature_idx ON ai_config_imports (environment, file_signature) WHERE status = 'applied';

COMMENT ON TABLE ai_config_imports IS
  'Lot 86B — journal des imports de la configuration IA globale (verebona-ia-config-export 2.0.0) et des retours arrière.';
COMMENT ON COLUMN ai_config_imports.file_content IS
  'Texte EXACT du fichier importé (imports appliqués seulement) ; sans secret (refusé à l’export comme à l’import).';
