-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0290 : configuration d'EXÉCUTION des versions de prompts maîtres
-- (lot 34D, ticket « T4 : découpler le contrat d'exécution du texte du prompt
-- maître »).
--
-- Chaque version de prompt maître (ai_master_prompt_versions, 0254) porte
-- désormais, EXPLICITEMENT, son mode d'exécution — jamais déduit de la
-- présence d'emplacements {{…}} dans le texte :
--   execution_mode           LEGACY_TEMPLATE (emplacements {{TASK}}, {{EVIDENCE}}…
--                            substitués, comportement historique) ou
--                            STRUCTURED_CONTEXT (texte libre ; contexte
--                            d'exécution construit, validé et injecté par le
--                            serveur depuis le contrat d'entrée) ;
--   input_contract_version   contrat d'entrée (t4_input_v1) — mode structuré ;
--   output_contract_version  contrat de sortie (t4_output_v1) — mode structuré ;
--   allowed_tasks            TASK autorisées (hors du texte du prompt).
-- Versions INDÉPENDANTES : prompt (version_number), contrat d'entrée et
-- contrat de sortie évoluent séparément.
--
-- Seul T4 déclare un contrat d'exécution au lot 34D. Les colonnes restent
-- NULL pour T1, T2, T3, T5 et T6 (LEGACY_TEMPLATE implicite, AUCUN
-- changement). Les versions T4 EXISTANTES sont posées explicitement en
-- LEGACY_TEMPLATE : leur comportement est conservé tant qu'une version en
-- contexte structuré n'est pas activée depuis le BO.
--
-- Immuabilité (déclencheur 0254 étendu) : la configuration d'exécution d'une
-- version sortie de l'état Brouillon ne change plus, comme son texte.
--
-- Petite table (quelques dizaines de lignes) : ALTER sans réécriture
-- (colonnes NULL sans défaut), UPDATE borné. Idempotente.
-- Retour arrière : les colonnes peuvent rester (ignorées par l'ancien code).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_master_prompt_versions ADD COLUMN IF NOT EXISTS execution_mode TEXT;
ALTER TABLE ai_master_prompt_versions ADD COLUMN IF NOT EXISTS input_contract_version TEXT;
ALTER TABLE ai_master_prompt_versions ADD COLUMN IF NOT EXISTS output_contract_version TEXT;
ALTER TABLE ai_master_prompt_versions ADD COLUMN IF NOT EXISTS allowed_tasks JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_prompt_versions_execution_mode_ck') THEN
    ALTER TABLE ai_master_prompt_versions ADD CONSTRAINT ai_master_prompt_versions_execution_mode_ck
      CHECK (execution_mode IS NULL OR execution_mode IN ('LEGACY_TEMPLATE', 'STRUCTURED_CONTEXT'));
  END IF;
END $$;

COMMENT ON COLUMN ai_master_prompt_versions.execution_mode IS
  'Lot 34D : mode d''exécution EXPLICITE (LEGACY_TEMPLATE | STRUCTURED_CONTEXT) ; NULL = LEGACY_TEMPLATE (prompts sans contrat d''exécution).';

-- Le déclencheur d'immuabilité est d'abord étendu (la mise à jour ci-dessous
-- ne touche que des colonnes NULL → valeur explicite, jamais un texte).
CREATE OR REPLACE FUNCTION ai_master_prompt_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (NEW.content IS DISTINCT FROM OLD.content
       OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
       OR NEW.status = 'DRAFT'
       -- Lot 34D : configuration d'exécution figée, sauf première pose
       -- explicite d'une valeur absente (migration des versions existantes).
       OR (OLD.execution_mode IS NOT NULL AND NEW.execution_mode IS DISTINCT FROM OLD.execution_mode)
       OR (OLD.input_contract_version IS NOT NULL AND NEW.input_contract_version IS DISTINCT FROM OLD.input_contract_version)
       OR (OLD.output_contract_version IS NOT NULL AND NEW.output_contract_version IS DISTINCT FROM OLD.output_contract_version)
       OR (OLD.allowed_tasks IS NOT NULL AND NEW.allowed_tasks IS DISTINCT FROM OLD.allowed_tasks)) THEN
    RAISE EXCEPTION 'ai_master_prompt_versions % (v%) : version % immuable — modifier un nouveau brouillon',
      OLD.id, OLD.version_number, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Versions T4 existantes : LEGACY_TEMPLATE explicite (comportement conservé).
UPDATE ai_master_prompt_versions
   SET execution_mode = 'LEGACY_TEMPLATE'
 WHERE treatment = 'T4' AND execution_mode IS NULL;
