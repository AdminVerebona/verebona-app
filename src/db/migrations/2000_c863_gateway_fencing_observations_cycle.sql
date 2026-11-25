-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 2000 : PASSERELLE IA — fencing des résultats de qualification,
-- observations historiques non opposables, compteurs cumulés par cycle de la
-- réévaluation des alertes (carte Trello #863, points P1-A1, P1-A3 et P1-D1 ;
-- suite de la migration 1980 de la carte #838).
--
--   · `ai_schema_compatibility.state_generation` : GÉNÉRATION de l'état d'un
--     couple, incrémentée à chaque transition d'état (accepté ↔ refusé ↔
--     réexamen). Une issue d'appel SANS bail n'est opposable que si l'état
--     n'a pas changé depuis la décision (même génération) : un constat tardif
--     ne peut plus écraser l'état écrit entre-temps par une autre instance.
--
--   · `ai_schema_compat_observations` : JOURNAL des issues d'appels portant
--     le schéma (acceptation, refus, sans conclusion), OPPOSABLES ou non. Une
--     issue écartée par le fencing (bail perdu, génération périmée) n'est
--     jamais appliquée à l'état courant, mais elle n'est pas perdue : elle est
--     conservée ici, avec la cause de son écartement. Aucun contenu : clé du
--     couple, codes, HTTP, version servie, dates.
--
--   · `ai_schema_compat_reeval_checkpoints` complétée : compteurs CUMULÉS du
--     cycle en cours (`cycle_counters`, mis à jour dans la MÊME transaction
--     que les effets d'une page et son curseur : un rejeu ne compte rien deux
--     fois), dernier statut et dernière erreur d'un passage (`last_status`,
--     `last_error`).
--
-- Additive, idempotente, rejouable, NON DESTRUCTIVE : aucune donnée reprise ni
-- supprimée. Retour arrière : ALTER TABLE … DROP COLUMN … ; DROP TABLE
-- ai_schema_compat_observations. Le code détecte l'absence (42703 / 42P01) et
-- revient au comportement de la carte #838, signalé : écriture fencée par le
-- seul jeton de bail, observations non journalisées, bilan du dernier passage.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- ── 1. Génération de l'état d'un couple (P1-A1, P1-A3) ──────────────────────
ALTER TABLE ai_schema_compatibility ADD COLUMN IF NOT EXISTS state_generation BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN ai_schema_compatibility.state_generation IS
  'Carte #863 (A1) : génération de l''état du couple, incrémentée à chaque transition ; une issue sans bail n''est opposable que si la génération n''a pas changé depuis la décision.';

-- ── 2. Observations historiques (opposables ou non) (P1-A1) ─────────────────
CREATE TABLE IF NOT EXISTS ai_schema_compat_observations (
  id                    BIGSERIAL    PRIMARY KEY,
  key_id                TEXT         NOT NULL,
  outcome               TEXT         NOT NULL,
  reason_code           TEXT,
  http_status           INTEGER,
  provider_code         TEXT,
  served_model_version  TEXT,
  qualification_kind    TEXT,
  opposable             BOOLEAN      NOT NULL,
  fence_cause           TEXT,
  decision_generation   BIGINT,
  app_version           TEXT,
  observed_at           TIMESTAMPTZ  NOT NULL,
  recorded_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_schema_compat_observations_key_idx ON ai_schema_compat_observations (key_id, observed_at);

COMMENT ON TABLE ai_schema_compat_observations IS
  'Carte #863 (A1) : issues d''appels portant le schéma, opposables ou écartées par le fencing (bail perdu, génération périmée) — jamais appliquées si non opposables, jamais perdues. Aucun contenu.';

-- ── 3. Compteurs cumulés par cycle de la réévaluation des alertes (P1-D1) ───
DO $$
BEGIN
  IF to_regclass('ai_schema_compat_reeval_checkpoints') IS NOT NULL THEN
    ALTER TABLE ai_schema_compat_reeval_checkpoints ADD COLUMN IF NOT EXISTS cycle_counters JSONB;
    ALTER TABLE ai_schema_compat_reeval_checkpoints ADD COLUMN IF NOT EXISTS last_status TEXT;
    ALTER TABLE ai_schema_compat_reeval_checkpoints ADD COLUMN IF NOT EXISTS last_error TEXT;
    COMMENT ON COLUMN ai_schema_compat_reeval_checkpoints.cycle_counters IS
      'Carte #863 (D1) : compteurs cumulés du cycle en cours (examinées, résolues par motif, conservées, échecs, reprises, levées, couples parcourus), écrits dans la transaction de chaque page — dédoublonnés au rejeu.';
  END IF;
END $$;
