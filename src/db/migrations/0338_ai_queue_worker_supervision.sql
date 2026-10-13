-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0338 : supervision du boucleur de la file IA et lien exécution T3
-- compte ↔ job de file (lot 52A — ticket « [P1] T3 — Identifier et corriger
-- le non-déclenchement des exécutions manuelles et horaires »).
--
--   ai_queue_worker_heartbeats
--       UNE ligne par processus web qui fait tourner le boucleur (instance
--       Scalingo, identifiant `hôte:pid:aléa`). Écrite à chaque tour (15 s) :
--       dernier tour, dernier prélèvement, exécutants enregistrés (T1/T3/T4),
--       places occupées. Le BO agrège TOUTES les instances vivantes : l'état
--       d'un seul processus n'est jamais présenté comme l'état du service.
--       Lignes de plus de 7 jours purgées par le boucleur lui-même.
--
--   account_reconciliation_runs.queue_job_id / queue_execution_id
--       Job de file (et jeton d'exécution) qui porte l'exécution T3 du compte.
--       Une exécution « running » dont le job n'est plus RUNNING avec ce jeton
--       (processus arrêté par un redéploiement) est close « failed » dès la
--       tentative suivante, au lieu de bloquer le compte 30 minutes.
--
-- Colonnes NULLABLE sans défaut : ajout instantané (catalogue seulement).
-- Table neuve, petite (une ligne par instance) : aucun index secondaire.
-- Tables non déclarées dans Drizzle (même choix que 0223 / 0337) : le code
-- tolère leur absence (supervision « inconnue », comportement antérieur).
-- Idempotente. Retour arrière : DROP TABLE IF EXISTS ai_queue_worker_heartbeats ;
-- ALTER TABLE account_reconciliation_runs DROP COLUMN IF EXISTS queue_job_id,
-- DROP COLUMN IF EXISTS queue_execution_id (code tolérant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_queue_worker_heartbeats (
  worker_id             TEXT        PRIMARY KEY,
  hostname              TEXT,
  pid                   INTEGER,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tick_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_claim_at         TIMESTAMPTZ,
  last_claim_treatment  TEXT,
  last_error            TEXT,
  last_error_at         TIMESTAMPTZ,
  handlers              TEXT[]      NOT NULL DEFAULT '{}',
  concurrency           INTEGER     NOT NULL DEFAULT 0,
  active_slots          INTEGER     NOT NULL DEFAULT 0,
  running_json          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  interval_ms           INTEGER     NOT NULL DEFAULT 15000
);

COMMENT ON TABLE ai_queue_worker_heartbeats IS
  'Lot 52A : battement de chaque boucleur de la file IA (une ligne par processus). Supervision du BO (File IA) : instances vivantes, dernière activité, exécutants enregistrés.';

ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS queue_job_id INTEGER;
ALTER TABLE account_reconciliation_runs ADD COLUMN IF NOT EXISTS queue_execution_id UUID;
