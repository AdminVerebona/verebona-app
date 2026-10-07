-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0272 : prompt maître T5 (Prompt Control) administrable depuis le BO
-- Lot 32B — décision PO n° 15 du 07/10/2026 : « Le prompt master T5 est
-- remplissable sur le BO comme pour les autres T ».
--
-- La migration 0254 limitait `ai_master_prompt_versions.treatment` à T1, T2,
-- T3, T4, T6 (T5 défini dans le dépôt, CDC BO IA T5-003). La contrainte est
-- remplacée par une contrainte qui accepte T5. Rien d'autre ne change : le
-- texte du dépôt reste la version initiale de T5 (v1 créée au premier geste),
-- et les interdits de T5 tenus par le serveur (T5 ne se modifie jamais
-- lui-même, cibles filtrées, brouillons seulement) restent dans le code.
--
-- Idempotente : la contrainte n'est remplacée que si elle n'accepte pas T5.
-- ──────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('ai_master_prompt_versions') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_master_prompt_versions_treatment_ck'
       AND pg_get_constraintdef(oid) NOT LIKE '%T5%'
  ) THEN
    ALTER TABLE ai_master_prompt_versions DROP CONSTRAINT ai_master_prompt_versions_treatment_ck;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_master_prompt_versions_treatment_ck') THEN
    ALTER TABLE ai_master_prompt_versions ADD CONSTRAINT ai_master_prompt_versions_treatment_ck
      CHECK (treatment IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('ai_master_prompt_versions') IS NOT NULL THEN
    COMMENT ON TABLE ai_master_prompt_versions IS
      'Versions des prompts maîtres T1-T6 administrées depuis le BO : Brouillon → Actif, historique immuable (BO-IA-PROMPTS-01, lot 27 ; T5 depuis le lot 32B).';
  END IF;
END $$;
