-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0709 : journal des changements de capacités des modèles (lot 85C,
-- CDC Pilotage IA V2 P4, CAT-03, QUAL-06, §16.2 « enregistrer … contraintes,
-- source/date de vérification »).
--
-- Une ligne par CHANGEMENT de fiche constaté par la synchronisation du
-- catalogue (champs avant / après, source), avec l'indication de la
-- requalification marquée. Un passage sans changement n'écrit rien (R46).
-- Journal technique de configuration IA, sans donnée de compte : exclu de
-- l'export de recette (motif dans recette-catalog.ts) et conservé lors d'une
-- restauration (RESTORE_KEEP_CURRENT_TABLES). Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_model_capability_changes (
  id                     BIGSERIAL   PRIMARY KEY,
  provider               TEXT        NOT NULL,
  model                  TEXT        NOT NULL,
  detected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger                TEXT,
  previous_sha256        TEXT,
  new_sha256             TEXT        NOT NULL,
  changes                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  requalification_marked BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS ai_model_capability_changes_model_idx
  ON ai_model_capability_changes (provider, model, detected_at DESC);

COMMENT ON TABLE ai_model_capability_changes IS
  'Lot 85C — journal des changements de capacités des modèles (requalification marquée sur événement).';
