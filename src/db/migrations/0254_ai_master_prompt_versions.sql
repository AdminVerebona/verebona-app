-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0254 : versions des prompts maîtres administrées depuis le BO
-- (ticket BO-IA-PROMPTS-01, lot 27).
--
-- Cycle de vie OBLIGATOIRE : Brouillon → Actif. Le corpus de tests n'est plus
-- une condition d'activation : il reste un contrôle qualité facultatif (0255).
--
-- ai_master_prompt_versions — une ligne par version d'UN prompt maître
-- (T1, T2, T3, T4, T6 ; T5 reste défini dans le dépôt, CDC BO IA T5-003) et
-- par environnement :
--   status          DRAFT (modifiable, jamais utilisé par l'application)
--                   | ACTIVE (utilisé ; une seule par environnement et prompt)
--                   | PREVIOUS (« ancienne », réactivable depuis l'historique) ;
--   version_number  v1, v2… par environnement et prompt (attribué à la
--                   création du brouillon) ;
--   content         texte COMPLET du prompt maître. IMMUABLE dès que la
--                   version n'est plus un brouillon (déclencheur ci-dessous :
--                   une version activée n'est jamais modifiée en place) ;
--   origin          initial_file / initial_config (version initiale reprise
--                   du fichier du dépôt ou de la version de configuration
--                   effective), admin (BO), prompt_control (T5).
--
-- ai_master_prompt_activations — journal de CHAQUE activation et de chaque
-- retour arrière : prompt, ancienne et nouvelle version, utilisateur, date,
-- état des tests au moment du geste (informatif, jamais bloquant).
--
-- Tables NEUVES : aucune table en service n'est verrouillée ; les index sont
-- créés avec elles (table vide, même parti que 0253). Idempotente.
-- Retour arrière : DROP TABLE ai_master_prompt_activations,
-- ai_master_prompt_versions CASCADE — l'application retombe alors sur le texte
-- de la version de configuration, puis sur le fichier du dépôt.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_master_prompt_versions (
  id                 SERIAL      PRIMARY KEY,
  environment        TEXT        NOT NULL,
  treatment          TEXT        NOT NULL,
  master_prompt_code TEXT        NOT NULL,
  version_number     INTEGER     NOT NULL,
  status             TEXT        NOT NULL,
  content            TEXT        NOT NULL,
  content_sha256     TEXT        NOT NULL,
  origin             TEXT        NOT NULL,
  based_on_id        INTEGER,
  created_by         INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         INTEGER,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by       INTEGER,
  activated_at       TIMESTAMPTZ,
  first_activated_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_prompt_versions_status_ck') THEN
    ALTER TABLE ai_master_prompt_versions ADD CONSTRAINT ai_master_prompt_versions_status_ck
      CHECK (status IN ('DRAFT', 'ACTIVE', 'PREVIOUS'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_prompt_versions_treatment_ck') THEN
    ALTER TABLE ai_master_prompt_versions ADD CONSTRAINT ai_master_prompt_versions_treatment_ck
      CHECK (treatment IN ('T1', 'T2', 'T3', 'T4', 'T6'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_prompt_versions_origin_ck') THEN
    ALTER TABLE ai_master_prompt_versions ADD CONSTRAINT ai_master_prompt_versions_origin_ck
      CHECK (origin IN ('initial_file', 'initial_config', 'admin', 'prompt_control'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_prompt_versions_number_uq') THEN
    ALTER TABLE ai_master_prompt_versions ADD CONSTRAINT ai_master_prompt_versions_number_uq
      UNIQUE (environment, treatment, version_number);
  END IF;
END $$;

-- Une seule version active et un seul brouillon par environnement et prompt.
CREATE UNIQUE INDEX IF NOT EXISTS ai_master_prompt_versions_one_active_uidx
  ON ai_master_prompt_versions (environment, treatment) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS ai_master_prompt_versions_one_draft_uidx
  ON ai_master_prompt_versions (environment, treatment) WHERE status = 'DRAFT';

-- Immuabilité : seul un brouillon voit son texte changer ; une version qui a
-- quitté l'état Brouillon ne peut jamais y revenir.
CREATE OR REPLACE FUNCTION ai_master_prompt_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (NEW.content IS DISTINCT FROM OLD.content
       OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
       OR NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'ai_master_prompt_versions % (v%) : version % immuable — modifier un nouveau brouillon',
      OLD.id, OLD.version_number, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_master_prompt_versions_immutable_trg ON ai_master_prompt_versions;
CREATE TRIGGER ai_master_prompt_versions_immutable_trg
  BEFORE UPDATE ON ai_master_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION ai_master_prompt_versions_immutable();

CREATE TABLE IF NOT EXISTS ai_master_prompt_activations (
  id                  SERIAL      PRIMARY KEY,
  environment         TEXT        NOT NULL,
  treatment           TEXT        NOT NULL,
  action              TEXT        NOT NULL,
  from_version_id     INTEGER,
  from_version_number INTEGER,
  to_version_id       INTEGER     NOT NULL,
  to_version_number   INTEGER     NOT NULL,
  user_id             INTEGER,
  user_email          TEXT,
  test_summary        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_prompt_activations_action_ck') THEN
    ALTER TABLE ai_master_prompt_activations ADD CONSTRAINT ai_master_prompt_activations_action_ck
      CHECK (action IN ('activate', 'rollback'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_master_prompt_activations_lookup_idx
  ON ai_master_prompt_activations (environment, treatment, created_at DESC);

COMMENT ON TABLE ai_master_prompt_versions IS
  'Versions des prompts maîtres T1-T4, T6 administrées depuis le BO : Brouillon → Actif, historique immuable (BO-IA-PROMPTS-01, lot 27).';
COMMENT ON TABLE ai_master_prompt_activations IS
  'Journal des activations et retours arrière des prompts maîtres (BO-IA-PROMPTS-01, lot 27).';
