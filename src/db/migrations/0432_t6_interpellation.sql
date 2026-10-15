-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0432 : décision d'interpellation T6 et rappels de l'accueil
-- (lot 60 — ticket « [P2] T6 — Améliorer la décision d'interpellation et
-- implémenter la gestion intelligente des rappels »).
--
--   t6_reminder_preferences — décisions de rappel PAR UTILISATEUR (Duo :
--       préférences individuelles, jamais celles de l'autre membre) :
--       « Me le rappeler plus tard » (SNOOZED + remind_at) et « Ne plus me
--       rappeler » (DISMISSED), sur une occurrence (échéance précise) ou sur
--       une série récurrente (series_key). Identifiant de sujet STABLE
--       (`agenda:<id>` / `series:<clé>`), jamais dérivé d'un texte IA.
--       Unicité (compte, utilisateur, sujet) : aucun doublon, même en cas de
--       traitements simultanés (écriture par ON CONFLICT). Une préférence
--       d'occurrence disparaît avec l'échéance (ON DELETE CASCADE) ; les
--       données de l'agenda ne sont JAMAIS modifiées par un rappel.
--
--   t6_interpellation_assessments — dernière évaluation IA (R13 du prompt
--       maître T6) de chaque échéance candidate du compte : conclusion,
--       démarche, justification, dates, priorité, empreinte du contexte
--       évalué. Donnée du COMPTE (porte sur les données métier partagées).
--
--   ai_execution_reports — le traitement T6 rejoint le reporting existant
--       (BO › Exécutions IA › Rapports) : sujets affichés ET écartés, motif,
--       seuil, rappel utilisateur.
--
-- Tables neuves (vides) : contraintes créées avec la table. Index annexes
-- dans 0432_..._idx_1 et _idx_2 (CONCURRENTLY). Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS … (le code tolère leur absence :
-- décision prudente sans préférence ni évaluation).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t6_reminder_preferences (
  id                   BIGSERIAL   PRIMARY KEY,
  account_id           INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id              INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_key          TEXT        NOT NULL,
  scope                TEXT        NOT NULL,
  agenda_item_id       INTEGER     REFERENCES agenda_items(id) ON DELETE CASCADE,
  series_key           TEXT,
  decision             TEXT        NOT NULL,
  remind_at            DATE,
  -- Empreinte du sujet au moment du choix (modification significative ensuite).
  context_fingerprint  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT t6_reminder_preferences_subject_uq UNIQUE (account_id, user_id, subject_key),
  CONSTRAINT t6_reminder_preferences_scope_check CHECK (
    (scope = 'OCCURRENCE' AND agenda_item_id IS NOT NULL)
    OR (scope = 'SERIES' AND series_key IS NOT NULL)),
  CONSTRAINT t6_reminder_preferences_decision_check CHECK (
    (decision = 'SNOOZED' AND remind_at IS NOT NULL)
    OR (decision = 'DISMISSED' AND remind_at IS NULL))
);

COMMENT ON TABLE t6_reminder_preferences IS
  'Lot 60 : décisions de rappel T6 par utilisateur (SNOOZED / DISMISSED, occurrence ou série). Préférence personnelle : aucune donnée métier modifiée.';

CREATE TABLE IF NOT EXISTS t6_interpellation_assessments (
  id                   BIGSERIAL   PRIMARY KEY,
  account_id           INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agenda_item_id       INTEGER     NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  subject_key          TEXT        NOT NULL,
  context_fingerprint  TEXT        NOT NULL,
  assessed_on          DATE        NOT NULL,
  interpellation       TEXT        NOT NULL,
  action_needed        BOOLEAN     NOT NULL,
  priority             TEXT        NOT NULL,
  action_date          DATE,
  reevaluate_on        DATE,
  reason               TEXT        NOT NULL,
  action               TEXT,
  consequence          TEXT,
  uncertainty          TEXT,
  exception_reason     TEXT,
  prompt_version       TEXT,
  trace_id             TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT t6_interpellation_assessments_subject_uq UNIQUE (account_id, subject_key),
  CONSTRAINT t6_interpellation_assessments_interpellation_check CHECK (interpellation IN ('ACT_NOW', 'ANTICIPATE', 'LATER', 'NONE')),
  CONSTRAINT t6_interpellation_assessments_priority_check CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW'))
);

COMMENT ON TABLE t6_interpellation_assessments IS
  'Lot 60 : dernière évaluation IA (R13, T6) de l''utilité d''interpeller sur une échéance du compte, avec l''empreinte du contexte évalué.';

-- T6 dans le reporting d'exécution (0421). La contrainte est REBÂTIE à partir
-- de sa définition courante, T6 ajouté — un traitement admis par une
-- migration intermédiaire est conservé. Rejouable sans effet.
DO $$
DECLARE
  def TEXT;
  vals TEXT;
BEGIN
  IF to_regclass('ai_execution_reports') IS NULL THEN RETURN; END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'ai_execution_reports_treatment_check' AND conrelid = 'ai_execution_reports'::regclass;
  IF def IS NOT NULL AND def LIKE '%''T6''%' THEN RETURN; END IF;
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO vals FROM (
    SELECT DISTINCT m[1] AS v FROM regexp_matches(coalesce(def, ''), '''([A-Z0-9_]+)''', 'g') AS m
    UNION SELECT 'T1' UNION SELECT 'T3' UNION SELECT 'T6'
  ) x;
  ALTER TABLE ai_execution_reports DROP CONSTRAINT IF EXISTS ai_execution_reports_treatment_check;
  EXECUTE format('ALTER TABLE ai_execution_reports ADD CONSTRAINT ai_execution_reports_treatment_check CHECK (treatment IN (%s)) NOT VALID', vals);
  ALTER TABLE ai_execution_reports VALIDATE CONSTRAINT ai_execution_reports_treatment_check;
END $$;
