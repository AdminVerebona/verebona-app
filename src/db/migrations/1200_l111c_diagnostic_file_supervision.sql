-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1200 : diagnostic global bloqué en file — remplacement des
-- demandes globales et supervision PERSISTANTE du worker des diagnostics
-- (lot 111C, ticket P1 du 04/11/2026, demande c229c2fd… restée QUEUED 2 h).
--
-- 1. `admin_export_generations` (file durable des diagnostics, lot 107G) :
--      cancel_reason        motif STABLE d'une annulation (ADMIN_CANCELLED,
--                           REPLACED_BY_NEW_REQUEST) ;
--      replaced_by          demande globale qui a remplacé celle-ci ;
--      cancel_requested_at / cancel_requested_by   horodatage et initiateur ;
--      wait_reason / wait_reason_at   raison d'attente constatée par le
--                           superviseur (preuve persistée d'une attente) ;
--      stall_alerted_at     première alerte BO « attente injustifiée ».
--
-- 2. `diagnostic_worker_heartbeats` : UNE ligne par processus Next (web ou
--    worker), écrite par le processus lui-même — worker démarré, désactivé
--    (variable en cause) ou absent de ce processus (rôle web/worker) ;
--    dernier tour, dernier prélèvement, travail en cours, raison d'attente,
--    dernière erreur, version, mémoire. Lue par le superviseur (indépendant
--    du worker) et par le BO : l'état du worker n'est plus lu dans la mémoire
--    de l'instance HTTP qui répond. Table technique transversale, sans
--    account_id ni secret (messages assainis) ; lignes non vues depuis 7 jours
--    supprimées par les processus eux-mêmes.
--
-- Additive, idempotente, rejouable. Retour arrière : DROP TABLE IF EXISTS
-- diagnostic_worker_heartbeats ; les colonnes ajoutées peuvent rester (le
-- code du lot 110 les ignore).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS replaced_by UUID;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS cancel_requested_by INTEGER;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS wait_reason TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS wait_reason_at TIMESTAMPTZ;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS stall_alerted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS diagnostic_worker_heartbeats (
  instance_id        TEXT        PRIMARY KEY,
  host               TEXT,
  pid                INTEGER,
  container          TEXT,
  process_type       TEXT        NOT NULL DEFAULT 'web',
  placement          TEXT        NOT NULL DEFAULT 'web',
  state              TEXT        NOT NULL,
  disabled_reason    TEXT,
  build_commit       TEXT,
  build_version      TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tick_at       TIMESTAMPTZ,
  last_tick_ok_at    TIMESTAMPTZ,
  tick_running_since TIMESTAMPTZ,
  last_claim_at      TIMESTAMPTZ,
  last_claim_job_id  UUID,
  current_job_id     UUID,
  wait_reason        TEXT,
  last_error         TEXT,
  last_error_at      TIMESTAMPTZ,
  interval_ms        INTEGER,
  memory_level       TEXT,
  rss_mb             INTEGER,
  container_limit_mb INTEGER,
  processed          INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT diagnostic_worker_heartbeats_state_check CHECK (state IN ('STARTED', 'DISABLED', 'NOT_THIS_PROCESS', 'STOPPED')),
  CONSTRAINT diagnostic_worker_heartbeats_process_check CHECK (process_type IN ('web', 'worker')),
  CONSTRAINT diagnostic_worker_heartbeats_placement_check CHECK (placement IN ('web', 'worker'))
);
