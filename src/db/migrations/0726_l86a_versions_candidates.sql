-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0726 : origine des versions de configuration et candidates
-- automatiques (lot 86A, CDC Pilotage IA V2 phase P5 : VER-01, ACT-01, ACT-02,
-- MIG-02, R04, R05, R47 ; décision PO n° 06).
--
--   · origin            `manual` (toute version existante : choix manuel, NON
--                       qualifiée — MIG-02) ou `auto` (candidate préparée par
--                       l'optimisation de préproduction) ;
--   · candidate_state   cycle d'une candidate automatique : CREATED →
--                       QUALIFYING → QUALIFIED / REFUSED / INCONCLUSIVE →
--                       ACTIVATED (préproduction seulement) ; NOT_CHOSEN si une
--                       autre candidate l'emporte ou si aucun gain n'est établi ;
--   · candidate_key     clé de la proposition (traitement, modèle, révision de
--                       référence, capacités) : une proposition identique n'est
--                       pas rejouée tant que rien n'a changé ;
--   · candidate_reason / candidate_campaign_id / candidate_base_revision_id.
-- Une candidate n'est JAMAIS l'active pendant ses tests (elle est créée non
-- active) ; seule une qualification complète l'active, en préproduction.
-- Idempotente ; aucune donnée existante modifiée (défaut `manual`).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_config_versions ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE ai_config_versions ADD COLUMN IF NOT EXISTS candidate_state TEXT;
ALTER TABLE ai_config_versions ADD COLUMN IF NOT EXISTS candidate_key TEXT;
ALTER TABLE ai_config_versions ADD COLUMN IF NOT EXISTS candidate_reason TEXT;
ALTER TABLE ai_config_versions ADD COLUMN IF NOT EXISTS candidate_campaign_id BIGINT;
ALTER TABLE ai_config_versions ADD COLUMN IF NOT EXISTS candidate_base_revision_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_config_versions_origin_chk') THEN
    ALTER TABLE ai_config_versions ADD CONSTRAINT ai_config_versions_origin_chk CHECK (origin IN ('manual', 'auto'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_config_versions_candidate_state_chk') THEN
    ALTER TABLE ai_config_versions ADD CONSTRAINT ai_config_versions_candidate_state_chk CHECK (
      candidate_state IS NULL OR candidate_state IN ('CREATED', 'QUALIFYING', 'QUALIFIED', 'REFUSED', 'INCONCLUSIVE', 'ACTIVATED', 'NOT_CHOSEN'));
  END IF;
END $$;

COMMENT ON COLUMN ai_config_versions.origin IS
  'Lot 86A : manual (choix d''un administrateur, jamais réputé qualifié — MIG-02) ou auto (candidate de l''optimisation de préproduction, activée seulement si qualifiée — décision 06).';
COMMENT ON COLUMN ai_config_versions.candidate_state IS
  'Lot 86A : cycle d''une candidate automatique (CREATED, QUALIFYING, QUALIFIED, REFUSED, INCONCLUSIVE, ACTIVATED, NOT_CHOSEN).';
