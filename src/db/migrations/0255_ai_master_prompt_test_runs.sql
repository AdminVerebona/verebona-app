-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0255 : exécutions « Tester avec le corpus » lancées depuis le BO
-- (ticket BO-IA-PROMPTS-01, lot 27).
--
-- Contrôle qualité FACULTATIF : aucune activation ne dépend de cette table.
-- Chaque exécution est rattachée à la version EXACTE testée — identifiant de
-- version ET empreinte du texte évalué (`content_sha256`) : un brouillon
-- modifié après son test n'hérite jamais du résultat de l'ancien contenu
-- (« Cette version n'a pas encore été testée »), qui reste consultable.
--
--   status      RUNNING | DONE | ERROR (RUNNING ancien = exécution
--               interrompue, présentée comme telle par le BO) ;
--   scenarios_* nombre de scénarios, succès, échecs ;
--   failures    scénarios en échec : identifiant, description, branche,
--               résultat attendu, résultat obtenu.
--
-- Rejeu sur sorties enregistrées : aucun appel modèle, coût nul.
-- Table neuve, idempotente. Retour arrière : DROP TABLE ai_master_prompt_test_runs.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_master_prompt_test_runs (
  id                SERIAL      PRIMARY KEY,
  prompt_version_id INTEGER     NOT NULL REFERENCES ai_master_prompt_versions(id) ON DELETE CASCADE,
  environment       TEXT        NOT NULL,
  treatment         TEXT        NOT NULL,
  content_sha256    TEXT        NOT NULL,
  status            TEXT        NOT NULL,
  scenarios_total   INTEGER     NOT NULL DEFAULT 0,
  scenarios_passed  INTEGER     NOT NULL DEFAULT 0,
  scenarios_failed  INTEGER     NOT NULL DEFAULT 0,
  failures          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  details           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error             TEXT,
  requested_by      INTEGER,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_prompt_test_runs_status_ck') THEN
    ALTER TABLE ai_master_prompt_test_runs ADD CONSTRAINT ai_master_prompt_test_runs_status_ck
      CHECK (status IN ('RUNNING', 'DONE', 'ERROR'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_master_prompt_test_runs_version_idx
  ON ai_master_prompt_test_runs (prompt_version_id, started_at DESC);

COMMENT ON TABLE ai_master_prompt_test_runs IS
  'Tests facultatifs « Tester avec le corpus » des prompts maîtres, rattachés à la version et au texte exacts (BO-IA-PROMPTS-01, lot 27).';
