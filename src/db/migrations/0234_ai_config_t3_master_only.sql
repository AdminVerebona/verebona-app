-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0234 : T3 en architecture « master » seule — DERNIER traitement
-- (lot 16b-3b, retrait de l'ancien moteur IA ; CDC 15 §25, §29, D-04).
--
-- Les opérations d'étapes de T3 (`resolve_ambiguity`, `reconcile_links`) et
-- les relais `legacy_asset_suggest`, `legacy_apply_suggestions`,
-- `legacy_enrich_coherence` sont retirés, avec le drapeau
-- `AI_RECONCILIATION_ENGINE` et le commutateur `T3_NEGATIVE_RECONCILIATION` :
-- le prompt maître `t3_master_v1` (branches VALUE_CONFLICT et LINK_AMBIGUITY)
-- est le seul moteur de la réconciliation. Après T5/T6 (0231), T2/T4 (0232)
-- et T1 (0233), PLUS AUCUN traitement n'a d'architecture `steps`.
--
-- Filet : la mise à jour porte sur TOUS les traitements (T1 à T6), pour qu'une
-- base qui aurait manqué une des migrations précédentes (ou une ligne écrite
-- entre-temps par un ancien code) soit alignée. Une ligne `steps` n'a plus de
-- sens :
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
-- s'exécute (il l'était déjà depuis le déploiement du code L16b-3b).
--
-- Même forme que 0231 (T5, T6), 0232 (T2, T4) et 0233 (T1), plus la valeur
-- par défaut de la colonne. Idempotente : ne touche que les lignes encore en
-- `steps` (relancée, 0 ligne) ; SET DEFAULT relancé est sans effet. Colonne 0220 absente
-- (migration 0220 en échec) : rien à aligner, le bloc DO ne fait rien plutôt
-- que d'échouer.
--
-- VERROUS : UPDATE de quelques lignes (au plus 6 par version), verrou de
-- ligne ; puis ALTER COLUMN … SET DEFAULT (métadonnée, ACCESS EXCLUSIVE
-- très bref sur une petite table de configuration) — tous deux bornés à 5 s. `SET LOCAL` : fichier multi-instructions =
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
     WHERE treatment IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6')
       AND prompt_architecture IS DISTINCT FROM 'master';
    -- Valeur par défaut de la colonne (0220 : 'steps') alignée : une ligne
    -- insérée sans la colonne (outil SQL, ancien code) naît `master`.
    -- Métadonnée seule (aucune réécriture de table), verrou bref borné par
    -- lock_timeout.
    ALTER TABLE ai_config_entries ALTER COLUMN prompt_architecture SET DEFAULT 'master';
  END IF;
END
$$;
