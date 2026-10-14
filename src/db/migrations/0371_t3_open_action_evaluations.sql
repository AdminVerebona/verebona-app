-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0371 : journal DURABLE des réexamens des « À traiter » ouverts par
-- T3 (lot 54A — ticket « [P1] T3 — Achever le réexamen systématique de tous
-- les À traiter ouverts », écart 6).
--
--   t3_open_action_evaluations
--       UNE ligne par carte examinée à chaque passage T3 global du compte
--       (phase « open actions » de `reconcileAccount`) : résolveur, mode
--       d'évaluation (FULL_REEVALUATION, DETERMINISTIC_REEVALUATION,
--       AI_REEVALUATION, OBSOLESCENCE_ONLY, NOT_T3, SUPERSEDED, ERROR),
--       tentative réelle de résolution, appel IA, issue. Le résumé du job
--       (`ai_job_queue.business_result_detail`) reste borné à 500 entrées ;
--       ce journal rend TOUTES les cartes auditables, au-delà de 500.
--       Identifiants et codes seulement (aucune donnée métier).
--       Rétention : 90 jours, purgée par compte à chaque passage.
--
-- Table neuve ; index dans 0371_..._idx_1 (CONCURRENTLY). Non déclarée dans
-- Drizzle (même choix que 0338) : le code tolère son absence (rapport du job
-- seul). Idempotente. Retour arrière : DROP TABLE IF EXISTS
-- t3_open_action_evaluations (code tolérant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS t3_open_action_evaluations (
  id                       BIGSERIAL   PRIMARY KEY,
  account_id               INTEGER     NOT NULL,
  account_run_id           INTEGER,
  queue_job_id             INTEGER,
  action_id                INTEGER     NOT NULL,
  rule_code                TEXT        NOT NULL,
  target_type              TEXT,
  target_id                INTEGER,
  resolver                 TEXT        NOT NULL,
  previous_resolution      TEXT,
  candidate_count          INTEGER,
  deterministic_attempted  BOOLEAN     NOT NULL DEFAULT FALSE,
  ai_called                BOOLEAN     NOT NULL DEFAULT FALSE,
  resolution_attempted     BOOLEAN     NOT NULL DEFAULT FALSE,
  evaluation_mode          TEXT        NOT NULL,
  new_resolution           TEXT,
  action_effect            TEXT        NOT NULL,
  fingerprint              TEXT,
  fingerprint_changed      BOOLEAN,
  note                     TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE t3_open_action_evaluations IS
  'Lot 54A : une ligne par carte « À traiter » examinée par un passage T3 global du compte (mode d''évaluation, tentative réelle, IA, issue). Rétention 90 jours.';
