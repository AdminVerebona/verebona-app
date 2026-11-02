-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0990 — lot 105C (ticket « BO T4 : un prompt maître, une
-- activation ») : BUNDLE d'exécution FIGÉ avec chaque nouvelle version T4.
--
--   ai_master_prompt_versions.execution_bundle (JSONB, NULL par défaut) :
--     bundle complet résolu et validé par le serveur au moment de
--     l'activation unifiée (identifiant du bundle, mode, contrats d'entrée et
--     de sortie, TASK, contrat de sortie runtime de chaque TASK, empreinte du
--     texte, date). NULL = version historique (antérieure au lot 105C) : ses
--     règles d'époque restent appliquées à l'identique (retour arrière exact).
--
-- Immuabilité (déclencheur 0254, étendu en 0290) : le bundle d'une version
-- sortie de l'état Brouillon ne change plus — et une version historique ne
-- reçoit JAMAIS de bundle a posteriori (aucune modification rétroactive).
--
-- Aucune donnée existante modifiée : les versions actives et historiques
-- gardent leur configuration ; aucune version n'est activée ni remplacée.
-- Petite table, colonne NULL sans défaut (pas de réécriture). Idempotente.
-- Retour arrière : la colonne peut rester (ignorée par l'ancien code).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_master_prompt_versions ADD COLUMN IF NOT EXISTS execution_bundle JSONB;

COMMENT ON COLUMN ai_master_prompt_versions.execution_bundle IS
  'Lot 105C : bundle d''exécution complet figé à l''activation (id, mode, contrats, TASK, sorties par TASK, empreinte) ; NULL = version historique.';

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
       OR (OLD.allowed_tasks IS NOT NULL AND NEW.allowed_tasks IS DISTINCT FROM OLD.allowed_tasks)
       -- Lot 105C : bundle figé, jamais posé a posteriori sur une version sortie du brouillon.
       OR NEW.execution_bundle IS DISTINCT FROM OLD.execution_bundle) THEN
    RAISE EXCEPTION 'ai_master_prompt_versions % (v%) : version % immuable — modifier un nouveau brouillon',
      OLD.id, OLD.version_number, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
