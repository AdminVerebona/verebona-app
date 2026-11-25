-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1980 : PASSERELLE IA — réservation partagée de la PREMIÈRE
-- qualification d'un schéma, motif d'absence de valeur littérale des faits T1,
-- point de reprise durable de la réévaluation des alertes de compatibilité
-- (carte Trello #838, points A1/A3, B1 et D1 ; suite des migrations 1710 et
-- 1795 des cartes #776 / #784).
--
--   · `ai_schema_compatibility` complétée, additivement :
--       qualification_claim_token   jeton de la réservation EN COURS d'un essai
--                                   de qualification (premier essai d'un couple
--                                   jamais testé, ou requalification d'une
--                                   qualification à version servie incertaine) ;
--       qualification_claimed_until fin du bail : au-delà (processus arrêté), la
--                                   réservation est caduque et reprenable ;
--       qualification_attempts      nombre de réservations accordées (trace).
--     Une seule instance tient le bail d'un couple : les autres partent en
--     mode JSON SANS schéma fournisseur (validation Zod locale inchangée),
--     jamais en essai parallèle du même schéma non qualifié. Pas de verrou
--     global : le bail porte sur UNE clé de couple.
--
--   · `document_facts.raw_value_absence` : motif CODIFIÉ et vérifiable de
--     l'absence de valeur littérale (`raw_value` NULL) d'un fait T1 écrit
--     après cette migration. NULLABLE, SANS DÉFAUT, SANS REPRISE : les faits
--     antérieurs restent NULL et sont lus « motif non renseigné (historique) »
--     — aucun motif n'est inventé pour eux.
--
--   · `ai_schema_compat_reeval_checkpoints` : point de reprise DURABLE du
--     passage de réévaluation des alertes de compatibilité de schéma
--     (`ai_schema_incompatibility` seulement), par périmètre : curseur sûr,
--     phase, cycle, bail (jeton + échéance), empreinte du périmètre. Un passage
--     interrompu reprend AU DERNIER CURSEUR SÛR sans paramètre manuel ; le
--     curseur est remis à zéro en fin de cycle. Aucune alerte de couverture T1
--     (#775) n'est lue ni écrite par ce passage.
--
-- Additive, idempotente, rejouable, NON DESTRUCTIVE. Aucun contenu de document,
-- de prompt ni de schéma : jetons, dates, compteurs, codes.
-- Retour arrière : ALTER TABLE … DROP COLUMN … ; DROP TABLE
-- ai_schema_compat_reeval_checkpoints. Le code détecte l'absence (42703 /
-- 42P01) et revient au comportement antérieur, signalé : premier essai non
-- réservé (comportement #784), motif d'absence non écrit, réévaluation sans
-- point de reprise (curseur explicite seulement).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- ── 1. Bail de qualification d'un couple (A1, A3) ───────────────────────────
ALTER TABLE ai_schema_compatibility ADD COLUMN IF NOT EXISTS qualification_claim_token TEXT;
ALTER TABLE ai_schema_compatibility ADD COLUMN IF NOT EXISTS qualification_claimed_until TIMESTAMPTZ;
ALTER TABLE ai_schema_compatibility ADD COLUMN IF NOT EXISTS qualification_attempts INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN ai_schema_compatibility.qualification_claim_token IS
  'Carte #838 (A1, A3) : jeton de la réservation en cours d''un essai de qualification (premier essai ou requalification) — une seule instance tient le bail du couple.';
COMMENT ON COLUMN ai_schema_compatibility.qualification_claimed_until IS
  'Carte #838 (A1) : fin du bail de qualification ; au-delà (processus arrêté), la réservation est caduque et reprenable par une autre instance.';
COMMENT ON COLUMN ai_schema_compatibility.qualification_attempts IS
  'Carte #838 (A1) : nombre de réservations de qualification accordées pour ce couple (trace, aucune décision).';

-- ── 2. Motif d'absence de valeur littérale d'un fait T1 (B1) ────────────────
DO $$
BEGIN
  IF to_regclass('document_facts') IS NOT NULL THEN
    ALTER TABLE document_facts ADD COLUMN IF NOT EXISTS raw_value_absence TEXT;
    COMMENT ON COLUMN document_facts.raw_value_absence IS
      'Carte #838 (B1) : motif codifié de l''absence de raw_value (VISUAL_ONLY, ILLEGIBLE, LITERAL_IN_EXCERPT, SOURCE_UNIT_REFERENCE, DERIVED_BY_RULE, NO_LITERAL, UNJUSTIFIED). NULL : raw_value présent, ou fait antérieur à la carte (motif non renseigné, jamais inventé).';
  END IF;
END $$;

-- ── 3. Point de reprise durable de la réévaluation des alertes (D1) ─────────
CREATE TABLE IF NOT EXISTS ai_schema_compat_reeval_checkpoints (
  scope              TEXT         PRIMARY KEY,
  scope_fingerprint  TEXT         NOT NULL,
  phase              TEXT         NOT NULL DEFAULT 'IDLE',
  alert_cursor       BIGINT       NOT NULL DEFAULT 0,
  couple_cursor      TEXT,
  cycle              INTEGER      NOT NULL DEFAULT 0,
  cycle_started_at   TIMESTAMPTZ,
  last_completed_at  TIMESTAMPTZ,
  examined_in_cycle  BIGINT       NOT NULL DEFAULT 0,
  lease_token        TEXT,
  lease_expires_at   TIMESTAMPTZ,
  resumes            INTEGER      NOT NULL DEFAULT 0,
  invalidations      INTEGER      NOT NULL DEFAULT 0,
  last_report        JSONB,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ai_schema_compat_reeval_checkpoints IS
  'Carte #838 (D1) : point de reprise durable de la réévaluation des alertes de compatibilité de schéma (code ai_schema_incompatibility seulement) — curseur sûr, phase, cycle, bail ; reprise automatique après arrêt, remise à zéro en fin de cycle. Aucune alerte de couverture T1 (#775).';
