-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0232 : T2 et T4 en architecture « master » seule (lot 16b-2,
-- retrait de l'ancien moteur IA ; CDC 15 §24, §26, D-04).
--
-- Les opérations d'étapes de T2 (`understand_request`, `generate_answer`,
-- `generate_answer_canonical`, `revalidate_fact`, relais `legacy_*_search`)
-- et de T4 (`classify_event`, `reconcile_status`, relais
-- `legacy_classify_home_category`) sont retirées : leur prompt maître
-- (`t2_master_v1`, `t4_master_v1`) est leur seul moteur. Une ligne `steps`
-- n'a donc plus de sens pour ces deux traitements :
--   · le code les lit déjà `master` quelle que soit la valeur stockée
--     (`config-types#promptArchitectureOf`) et refuse toute demande `steps`
--     (`checkPromptArchitectureChange`, `masterConfigIssues`) ;
--   · cette migration aligne la donnée stockée, pour toutes les versions
--     (Brouillon, À tester, Validée, Active, archivées) : les diffs, les
--     packages exportés et les lectures SQL directes disent la même chose
--     que le code.
--
-- `master_prompt` n'est PAS touché : vide, le fichier du dépôt s'applique
-- (D-03) ; un texte master préparé dans une version devient celui qui
-- s'exécute (il l'était déjà depuis le déploiement du code L16b-2).
--
-- Même forme que 0231 (T5, T6). Idempotente : ne touche que les lignes encore
-- en `steps` (relancée, 0 ligne). Colonne 0220 absente (migration 0220 en
-- échec) : rien à aligner, le bloc DO ne fait rien plutôt que d'échouer.
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
     WHERE treatment IN ('T2', 'T4')
       AND prompt_architecture IS DISTINCT FROM 'master';
  END IF;
END
$$;
