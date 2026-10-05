-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0233 : T1 en architecture « master » seule (lot 16b-3, retrait de
-- l'ancien moteur IA ; CDC 15 §23, §29, D-04).
--
-- Les opérations d'étapes de T1 (`group_sources`, `extract_source`,
-- `classify_document`, `classify_rubric`, `identify_entities`,
-- `propose_links`) et le relais `legacy_document_analysis` sont retirés, avec
-- le commutateur `AI_T1_ANALYSIS_MODE` et le drapeau
-- `AI_UNIFIED_SOURCE_ANALYSIS` : le prompt maître `t1_master_v1` (branches
-- GROUP_UPLOAD et ANALYZE_DOCUMENT) est le seul moteur d'analyse des sources.
-- Une ligne `steps` n'a donc plus de sens pour T1 :
--   · le code la lit déjà `master` quelle que soit la valeur stockée
--     (`config-types#promptArchitectureOf`) et refuse toute demande `steps`
--     (`checkPromptArchitectureChange`, `masterConfigIssues`) ;
--   · cette migration aligne la donnée stockée, pour toutes les versions
--     (Brouillon, À tester, Validée, Active, archivées) : les diffs, les
--     packages exportés et les lectures SQL directes disent la même chose
--     que le code.
--
-- `master_prompt` n'est PAS touché : vide, le fichier du dépôt s'applique
-- (D-03) ; un texte master préparé dans une version devient celui qui
-- s'exécute (il l'était déjà depuis le déploiement du code L16b-3).
--
-- Même forme que 0231 (T5, T6) et 0232 (T2, T4). Idempotente : ne touche que
-- les lignes encore en `steps` (relancée, 0 ligne). Colonne 0220 absente
-- (migration 0220 en échec) : rien à aligner, le bloc DO ne fait rien plutôt
-- que d'échouer.
--
-- VERROUS : UPDATE de quelques lignes (au plus 1 par version) ; verrou de
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
     WHERE treatment IN ('T1')
       AND prompt_architecture IS DISTINCT FROM 'master';
  END IF;
END
$$;
