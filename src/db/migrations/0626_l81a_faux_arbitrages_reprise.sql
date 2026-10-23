-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0626 : rattrapage des FAUX ARBITRAGES « À traiter » (lot 81A,
-- ticket « [P1] T3 / À traiter — Corriger les faux arbitrages entre valeurs
-- identiques », §3.3).
--
--   to_process_arbitration_reprises — état d'une CAMPAGNE de rattrapage
--     (une ligne par code de campagne) : curseur sur l'identifiant de carte
--     (reprise après redémarrage), compteurs par issue, nombre de passages,
--     dernier échantillon d'erreur, fin. Bornée par passage et reprenable :
--     exécutée par la tâche planifiée interne
--     `to-process-relevance-reevaluation` (toutes les heures) et lisible au
--     BO (Exploitation › Rattrapages, tâches planifiées).
--
-- Aucune donnée de compte ici (ni compte, ni bien, ni document) : le détail
-- de CHAQUE carte réexaminée (valeur en place, valeurs candidates, preuves,
-- motif initial, décision corrective) est tracé dans l'existant
-- `to_process_action_events` (événements PROPOSALS_CORRECTED / OBSOLETE /
-- REPRISE_ERROR), exporté par « Données du compte ». Le rattrapage ne modifie
-- JAMAIS les valeurs de la fiche ; aucune carte n'est supprimée.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS to_process_arbitration_reprises (
  code              TEXT        PRIMARY KEY,
  -- RUNNING | DONE
  status            TEXT        NOT NULL DEFAULT 'RUNNING',
  cursor_action_id  INTEGER     NOT NULL DEFAULT 0,
  counters          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  runs              INTEGER     NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at       TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  error_sample      TEXT
);

DO $$ BEGIN
  ALTER TABLE to_process_arbitration_reprises
    ADD CONSTRAINT to_process_arbitration_reprises_status_chk CHECK (status IN ('RUNNING', 'DONE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
