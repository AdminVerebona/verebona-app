-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0861 : vocabulaire de la mise en conformité automatique des
-- prompts (lot 99B). Trois contraintes ÉLARGIES (la liste précédente reste un
-- sous-ensemble ; aucune donnée reprise ni modifiée) :
--
--   · ai_master_prompt_versions.origin       + `auto_conformity` : révision
--     de prompt maître préparée par le système à partir de la version ACTIVE
--     réelle (bloc officiel du guide du PO inséré à son ancre, reste du texte
--     inchangé). Créée « ancienne » (jamais un brouillon : le brouillon reste
--     au PO), activée seulement par sa candidate de configuration qualifiée.
--   · ai_qualification_campaigns.kind        + `CONFORMITY` : campagne de
--     non-régression ancienne version active ↔ candidate, mêmes entrées,
--     toutes les opérations du prompt modifié (lot 86A réutilisé).
--   · ai_config_versions.candidate_state     + `SUSPENDED` : candidate
--     retirée après un retour arrière automatique (anomalie imputable au
--     prompt) — jamais réactivée automatiquement.
--
-- Additive, idempotente. Retour arrière : contraintes rétablies sans ces
-- valeurs après suppression logique des lignes qui les portent.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('ai_master_prompt_versions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_master_prompt_versions'::regclass
                AND conname = 'ai_master_prompt_versions_origin_ck' AND pg_get_constraintdef(oid) NOT LIKE '%auto_conformity%') THEN
      ALTER TABLE ai_master_prompt_versions DROP CONSTRAINT ai_master_prompt_versions_origin_ck;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_master_prompt_versions'::regclass
                    AND conname = 'ai_master_prompt_versions_origin_ck') THEN
      ALTER TABLE ai_master_prompt_versions ADD CONSTRAINT ai_master_prompt_versions_origin_ck
        CHECK (origin IN ('initial_file', 'initial_config', 'admin', 'prompt_control', 'auto_conformity'));
    END IF;
  END IF;

  IF to_regclass('ai_qualification_campaigns') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_qualification_campaigns'::regclass
                AND conname = 'ai_qualification_campaigns_kind_chk' AND pg_get_constraintdef(oid) NOT LIKE '%CONFORMITY%') THEN
      ALTER TABLE ai_qualification_campaigns DROP CONSTRAINT ai_qualification_campaigns_kind_chk;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_qualification_campaigns'::regclass
                    AND conname = 'ai_qualification_campaigns_kind_chk') THEN
      ALTER TABLE ai_qualification_campaigns ADD CONSTRAINT ai_qualification_campaigns_kind_chk
        CHECK (kind IN ('MANUAL', 'AUTO', 'CONFORMITY'));
    END IF;
  END IF;

  IF to_regclass('ai_config_versions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_config_versions'::regclass
                AND conname = 'ai_config_versions_candidate_state_chk' AND pg_get_constraintdef(oid) NOT LIKE '%SUSPENDED%') THEN
      ALTER TABLE ai_config_versions DROP CONSTRAINT ai_config_versions_candidate_state_chk;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_config_versions'::regclass
                    AND conname = 'ai_config_versions_candidate_state_chk') THEN
      ALTER TABLE ai_config_versions ADD CONSTRAINT ai_config_versions_candidate_state_chk CHECK (
        candidate_state IS NULL OR candidate_state IN ('CREATED', 'QUALIFYING', 'QUALIFIED', 'REFUSED', 'INCONCLUSIVE', 'ACTIVATED', 'NOT_CHOSEN', 'SUSPENDED'));
    END IF;
  END IF;
END $$;
