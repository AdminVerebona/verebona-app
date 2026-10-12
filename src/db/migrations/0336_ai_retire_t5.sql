-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0336 : retrait définitif de T5 (Prompt Control) — NON DESTRUCTIF
-- Lot 49 (49E), ticket 12 « BO IA — Supprimer définitivement T5 (Prompt
-- Control) sans régression des traitements IA » (T5-DEL-06).
--
-- Principes :
--   · AUCUNE donnée historique supprimée : lignes T5 des versions de
--     configuration (ai_config_entries), versions / activations / tests des
--     prompts maîtres T5, exécutions de corpus, traces et coûts
--     (ai_usage_event, AI_GOVERNANCE / t5_analyze / t5_modify) sont CONSERVÉS.
--     Le code les ignore (référentiel à cinq traitements T1, T2, T3, T4, T6).
--   · Les contraintes CHECK existantes continuent d'ACCEPTER 'T5' : sans
--     cela, les anciennes lignes rendraient la contrainte invalide (et toute
--     restauration d'une sauvegarde impossible). L'interdiction porte sur les
--     NOUVELLES lignes : déclencheur `ai_retired_treatment_guard` (INSERT, ou
--     UPDATE qui POSE 'T5') sur les tables des PROMPTS MAÎTRES (versions,
--     activations, tests) — aucune nouvelle version de prompt ni activation
--     T5, même par SQL.
--   · Retour arrière applicatif compatible : la configuration versionnée
--     (`ai_config_entries`), l'état des traitements et les budgets ne portent
--     PAS de déclencheur — l'ancien code (qui écrit une ligne T5 à chaque
--     brouillon) doit rester fonctionnel s'il est redéployé. Pour le code du
--     lot 49, ces écritures sont refusées par le serveur (dépôt des versions,
--     route 410, import de package).
--   · État OPÉRATIONNEL neutralisé : la ligne T5 de `ai_treatment_state` et
--     un budget T5 de `ai_cost_settings` (paramètres, pas de l'historique)
--     sont ARCHIVÉS (copie JSON intégrale, vérifiable) dans
--     `ai_retired_treatment_archive`, puis retirés. Réversible : la copie
--     permet de les rétablir à l'identique ; l'ancien code recrée de toute
--     façon une ligne d'état absente à la demande (valeur par défaut ENABLED).
--   · Aucune donnée d'un autre traitement n'est touchée.
--
-- Idempotente : archivage `ON CONFLICT DO NOTHING`, suppressions ciblées,
-- fonction `CREATE OR REPLACE`, déclencheurs recréés (`DROP … IF EXISTS`).
-- Tolérante : une table absente (migration antérieure non appliquée) est
-- ignorée. Exécutable en préproduction puis en production.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_retired_treatment_archive (
  id            BIGSERIAL   PRIMARY KEY,
  source_table  TEXT        NOT NULL,
  treatment     TEXT        NOT NULL,
  row_key       TEXT        NOT NULL,
  row_data      JSONB       NOT NULL,
  reason        TEXT        NOT NULL,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_retired_treatment_archive_row_uq UNIQUE (source_table, row_key)
);

COMMENT ON TABLE ai_retired_treatment_archive IS
  'Copie intégrale (JSON) des lignes OPÉRATIONNELLES d''un traitement retiré avant leur neutralisation '
  '(lot 49 : T5 Prompt Control). Vérifiable et réversible. L''historique (versions, traces, coûts) n''est pas déplacé : il reste en place.';

-- 1. Archivage puis neutralisation de l'état opérationnel T5.
DO $$
BEGIN
  IF to_regclass('ai_treatment_state') IS NOT NULL THEN
    INSERT INTO ai_retired_treatment_archive (source_table, treatment, row_key, row_data, reason)
    SELECT 'ai_treatment_state', s.treatment, 'treatment=' || s.treatment, to_jsonb(s),
           'Lot 49 : état opérationnel du traitement retiré T5 (Prompt Control).'
      FROM ai_treatment_state s
     WHERE s.treatment = 'T5'
    ON CONFLICT (source_table, row_key) DO NOTHING;

    -- Suppression seulement si la copie existe (vérifiable).
    DELETE FROM ai_treatment_state s
     WHERE s.treatment = 'T5'
       AND EXISTS (SELECT 1 FROM ai_retired_treatment_archive a
                    WHERE a.source_table = 'ai_treatment_state' AND a.row_key = 'treatment=' || s.treatment);
  END IF;

  IF to_regclass('ai_cost_settings') IS NOT NULL THEN
    INSERT INTO ai_retired_treatment_archive (source_table, treatment, row_key, row_data, reason)
    SELECT 'ai_cost_settings', c.scope, 'scope=' || c.scope, to_jsonb(c),
           'Lot 49 : budget mensuel du traitement retiré T5 (Prompt Control).'
      FROM ai_cost_settings c
     WHERE c.scope = 'T5'
    ON CONFLICT (source_table, row_key) DO NOTHING;

    DELETE FROM ai_cost_settings c
     WHERE c.scope = 'T5'
       AND EXISTS (SELECT 1 FROM ai_retired_treatment_archive a
                    WHERE a.source_table = 'ai_cost_settings' AND a.row_key = 'scope=' || c.scope);
  END IF;
END $$;

-- 2. Garde : aucune NOUVELLE ligne d'un traitement retiré.
CREATE OR REPLACE FUNCTION ai_retired_treatment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col TEXT := TG_ARGV[0];
  nouveau TEXT;
  ancien TEXT;
BEGIN
  nouveau := to_jsonb(NEW) ->> col;
  IF nouveau IS DISTINCT FROM 'T5' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    ancien := to_jsonb(OLD) ->> col;
    -- Ligne historique déjà T5 : jamais bloquée (aucune réécriture d'historique).
    IF ancien IS NOT DISTINCT FROM nouveau THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Le traitement T5 (Prompt Control) est supprimé (lot 49) : aucune nouvelle ligne % dans %.', col, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$;

COMMENT ON FUNCTION ai_retired_treatment_guard() IS
  'Lot 49 : refuse toute nouvelle ligne (ou mise à jour qui pose) un traitement retiré (T5). Les lignes historiques restent lisibles.';

DO $$
DECLARE
  cible RECORD;
BEGIN
  FOR cible IN
    SELECT * FROM (VALUES
      ('ai_master_prompt_versions', 'treatment'),
      ('ai_master_prompt_activations', 'treatment'),
      ('ai_master_prompt_test_runs', 'treatment')
    ) AS t(tbl, col)
  LOOP
    IF to_regclass(cible.tbl) IS NOT NULL AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = cible.tbl AND column_name = cible.col
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS ai_retired_treatment_guard ON %I', cible.tbl);
      EXECUTE format(
        'CREATE TRIGGER ai_retired_treatment_guard BEFORE INSERT OR UPDATE OF %I ON %I '
        'FOR EACH ROW EXECUTE FUNCTION ai_retired_treatment_guard(%L)',
        cible.col, cible.tbl, cible.col);
    END IF;
  END LOOP;
END $$;

-- 3. Tables SANS garde (retour arrière applicatif) : retrait d'un éventuel
--    déclencheur posé par une version de travail de cette migration.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ai_config_entries', 'ai_treatment_state', 'ai_master_corpus_runs', 'ai_job_queue', 'ai_cost_settings']
  LOOP
    IF to_regclass(tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS ai_retired_treatment_guard ON %I', tbl);
    END IF;
  END LOOP;
END $$;
