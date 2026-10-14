-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0345 : correction CONTRÔLÉE des relations intercomptes héritées
-- (lot 53, retour PO D23 « corriger avant production » : le simple signalement
-- du lot 49 ne suffit pas).
--
--   cross_account_remediations
--       Journal ligne à ligne de chaque correction appliquée depuis le BO
--       (Exploitation › Rattrapages › « Relations intercomptes », par
--       catégorie) : table et clé de la ligne touchée, catégorie, état AVANT
--       (ligne complète, `to_jsonb`), modification faite, comptes concernés,
--       motif. Sert à la RESTAURATION (« Restaurer » du BO, par identifiant
--       d'exécution) et de preuve (rapport). Jamais purgée automatiquement.
--
--   cross_account_link_guard()  (déclencheur de la migration 0332)
--       Redéfini à l'identique, avec UNE exception : la restauration
--       journalisée d'une correction (et elle seule) pose, dans SA
--       transaction, `SET LOCAL verebona.cross_account_restore = 'on'` pour
--       réinsérer telle quelle la ligne retirée. Paramètre de transaction
--       (SET LOCAL) : sans effet hors de cette transaction ; aucun chemin
--       applicatif ordinaire ne le pose.
--
-- Table neuve et vide : création instantanée ; index secondaire construit
-- CONCURRENTLY dans 0345_cross_account_remediation_idx_1.sql.
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE). Retour arrière : rejouer
-- 0332 (fonction d'origine) puis DROP TABLE IF EXISTS cross_account_remediations
-- (le BO signale alors la correction indisponible).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cross_account_remediations (
  id                BIGSERIAL   PRIMARY KEY,
  run_id            UUID        NOT NULL,
  category          TEXT        NOT NULL,
  table_name        TEXT        NOT NULL,
  row_pk            JSONB       NOT NULL,
  mode              TEXT        NOT NULL,
  before_row        JSONB       NOT NULL,
  change            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  account_id        INTEGER,
  other_account_id  INTEGER,
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at       TIMESTAMPTZ,
  restore_run_id    UUID,
  restore_outcome   TEXT,
  CONSTRAINT cross_account_remediations_mode_ck CHECK (mode IN ('nullify', 'status', 'delete'))
);

CREATE OR REPLACE FUNCTION cross_account_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_row    JSONB := to_jsonb(NEW);
  v_left   INTEGER := (v_row ->> TG_ARGV[1])::INTEGER;
  v_right  INTEGER := (v_row ->> TG_ARGV[3])::INTEGER;
  a_left   INTEGER;
  a_right  INTEGER;
BEGIN
  IF v_left IS NULL OR v_right IS NULL THEN RETURN NEW; END IF;
  -- Lot 53 : restauration journalisée d'une correction (BO), transaction seule.
  IF current_setting('verebona.cross_account_restore', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(OLD) ->> TG_ARGV[1]) IS NOT DISTINCT FROM (v_row ->> TG_ARGV[1])
     AND (to_jsonb(OLD) ->> TG_ARGV[3]) IS NOT DISTINCT FROM (v_row ->> TG_ARGV[3]) THEN
    RETURN NEW;
  END IF;
  a_left  := cross_account_of(TG_ARGV[0], v_left);
  a_right := cross_account_of(TG_ARGV[2], v_right);
  IF a_left IS NOT NULL AND a_right IS NOT NULL AND a_left <> a_right THEN
    RAISE EXCEPTION 'CROSS_ACCOUNT_LINK: % % (compte %) / % % (compte %) — relation intercomptes refusée (%)',
      TG_ARGV[0], v_left, a_left, TG_ARGV[2], v_right, a_right, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
