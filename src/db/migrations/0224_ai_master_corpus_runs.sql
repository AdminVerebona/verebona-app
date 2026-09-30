-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0224 : exécutions du corpus des prompts maîtres (CDC 15 §30, §32 ;
-- décisions D-08, D-17 ; action humaine HC-06).
--
-- Règle de recette §30 : « un master prompt n'est activable que si toutes ses
-- branches TASK/MODE passent leur corpus propre ». Chaque exécution du corpus
-- rejoué (`scripts/run-master-corpus.ts`, fixtures synthétiques D-08) est
-- enregistrée ici, PAR TRAITEMENT et pour une EMPREINTE de texte master :
-- la garde d'activation (`governance/master-corpus/activation-guard.ts`)
-- refuse la mise en service d'une version dont un traitement en `master`
-- n'a pas d'exécution VERTE sur l'empreinte exacte de son texte, avec toutes
-- ses branches couvertes.
--
--   config_version_id : version évaluée (NULL : fichiers du dépôt, ex. CI) ;
--   text_sha256       : empreinte SHA-256 du texte master évalué ;
--   text_source       : `config` (texte de la version) ou `file` (dépôt) ;
--   branches_*        : branches exigées (registre) et branches vertes ;
--   status            : PASSED | FAILED ;
--   source            : ci | preprod | prod | local (lieu d'exécution ; la
--                       garde n'accepte jamais `local`) ;
--   run_mode          : replay (sorties enregistrées, D-08 : structure du
--                       texte + contrôles serveur) | live (appel RÉEL du
--                       modèle par la passerelle sur le sous-ensemble
--                       critique, D-17 : exigé en préprod pour un texte
--                       master de version différent du fichier du dépôt) ;
--   details           : résultats par cas (identifiant, branche, erreurs).
--
-- Table nouvelle, aucune donnée existante touchée : création idempotente,
-- sans verrou sur une table en service.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_master_corpus_runs (
  id                   BIGSERIAL PRIMARY KEY,
  config_version_id    INTEGER,
  treatment            TEXT        NOT NULL,
  master_prompt_code   TEXT        NOT NULL,
  master_prompt_version TEXT       NOT NULL,
  text_sha256          TEXT        NOT NULL,
  text_source          TEXT        NOT NULL,
  branches_required    TEXT[]      NOT NULL DEFAULT '{}',
  branches_passed      TEXT[]      NOT NULL DEFAULT '{}',
  cases_total          INTEGER     NOT NULL DEFAULT 0,
  cases_passed         INTEGER     NOT NULL DEFAULT 0,
  status               TEXT        NOT NULL,
  source               TEXT        NOT NULL,
  run_mode             TEXT        NOT NULL DEFAULT 'replay',
  environment          TEXT,
  git_sha              TEXT,
  details              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by           INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Base où une première version de la table existerait déjà (préversion du lot).
ALTER TABLE ai_master_corpus_runs ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'replay';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_corpus_runs_status_ck') THEN
    ALTER TABLE ai_master_corpus_runs ADD CONSTRAINT ai_master_corpus_runs_status_ck
      CHECK (status IN ('PASSED', 'FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_corpus_runs_source_ck') THEN
    ALTER TABLE ai_master_corpus_runs ADD CONSTRAINT ai_master_corpus_runs_source_ck
      CHECK (source IN ('ci', 'preprod', 'prod', 'local'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_corpus_runs_run_mode_ck') THEN
    ALTER TABLE ai_master_corpus_runs ADD CONSTRAINT ai_master_corpus_runs_run_mode_ck
      CHECK (run_mode IN ('replay', 'live'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_corpus_runs_text_source_ck') THEN
    ALTER TABLE ai_master_corpus_runs ADD CONSTRAINT ai_master_corpus_runs_text_source_ck
      CHECK (text_source IN ('config', 'file'));
  END IF;
END $$;

-- Lecture de la garde : dernière exécution pour (master, empreinte).
CREATE INDEX IF NOT EXISTS ai_master_corpus_runs_lookup_idx
  ON ai_master_corpus_runs (master_prompt_code, text_sha256, run_mode, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_master_corpus_runs_version_idx
  ON ai_master_corpus_runs (config_version_id, treatment, created_at DESC);
