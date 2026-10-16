-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0446 : recette de la pertinence « À traiter » avec le VÉRITABLE
-- T4 (lot 61 — ticket « BUG P1 — À traiter : écarts résiduels du lot 58B »,
-- écart 8 « tests T4 principalement simulés »).
--
--   to_process_relevance_recette_runs — une exécution, lancée depuis le BO
--       (File d'attente IA › Pertinence « À traiter » › « Lancer la recette
--       T4 réelle »), du corpus de contrats livré (actifs, expirés, résiliés,
--       reconductibles, prêts, historiques sans date…) avec la configuration
--       IA ACTIVE de l'environnement : version de configuration T4, résultat
--       attendu et obtenu par cas, appels IA, erreurs. Aucun SQL ni aucune
--       commande pour le PO.
--
-- Table neuve (vide). Idempotente. Retour arrière : DROP TABLE IF EXISTS
-- (le BO signale alors « migration absente »).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS to_process_relevance_recette_runs (
  id             BIGSERIAL   PRIMARY KEY,
  requested_by   INTEGER,
  account_id     INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
  -- RUNNING | DONE | ERROR
  status         TEXT        NOT NULL DEFAULT 'RUNNING',
  config_ref     TEXT,
  engine_version TEXT        NOT NULL,
  total          INTEGER     NOT NULL DEFAULT 0,
  passed         INTEGER     NOT NULL DEFAULT 0,
  failed         INTEGER     NOT NULL DEFAULT 0,
  ai_calls       INTEGER     NOT NULL DEFAULT 0,
  -- [{caseId, description, expected, obtained, ok, aiCalled, aiStatus, traceId, reason}]
  results        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  error          TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  CONSTRAINT to_process_relevance_recette_runs_status_chk CHECK (status IN ('RUNNING', 'DONE', 'ERROR'))
);

COMMENT ON TABLE to_process_relevance_recette_runs IS
  'Lot 61 : recette de la pertinence « À traiter » avec le véritable T4 (corpus livré, lancée depuis le BO).';
