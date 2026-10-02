-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0231 : T5 et T6 en architecture « master » seule (lot 16b, retrait
-- de l'ancien moteur IA ; CDC 15 §27, §28, D-04).
--
-- Les opérations d'étapes de T5 (`analyze_instruction`, `control_prompts`,
-- `propose_change`) et de T6 (`formulate_mascot`) sont retirées : leur prompt
-- maître (`t5_master_v1`, `t6_master_v1`) est leur seul moteur. Une ligne
-- `steps` n'a donc plus de sens pour ces deux traitements :
--   · le code les lit déjà `master` quelle que soit la valeur stockée
--     (`config-types#promptArchitectureOf`) et refuse toute demande `steps`
--     (`checkPromptArchitectureChange`, `masterConfigIssues`) ;
--   · cette migration aligne la donnée stockée, pour toutes les versions
--     (Brouillon, À tester, Validée, Active, archivées) : les diffs, les
--     packages exportés et les lectures SQL directes disent la même chose
--     que le code.
--
-- `master_prompt` n'est PAS touché : vide, le fichier du dépôt s'applique
-- (D-03) ; T5 n'en porte jamais (non administrable, normalisé à l'écriture).
--
-- Aucune version n'est modifiée dans son comportement : depuis le lot 16b, le
-- code exécute de toute façon le master pour T5 et T6.
--
-- Idempotente : ne touche que les lignes encore en `steps` (relancée, 0 ligne).
-- Colonne 0220 absente (migration 0220 en échec) : rien à aligner, le bloc
-- DO ne fait rien plutôt que d'échouer.
--
-- VERROUS : UPDATE de quelques lignes (au plus 2 par version) ; verrou de
-- ligne seulement, borné à 5 s. `SET LOCAL` : fichier multi-instructions =
-- une transaction implicite, le réglage ne fuit pas sur le pool.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'ai_config_entries'
       AND column_name = 'prompt_architecture'
  ) THEN
    UPDATE ai_config_entries
       SET prompt_architecture = 'master'
     WHERE treatment IN ('T5', 'T6')
       AND prompt_architecture IS DISTINCT FROM 'master';
  END IF;
END
$$;
