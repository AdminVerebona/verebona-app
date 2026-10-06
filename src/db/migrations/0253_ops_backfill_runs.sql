-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0253 : exécutions des rattrapages de données lancées depuis le BO
-- (page « Exploitation », lot 25 chantier B).
--
-- Une ligne par exécution (simulation, application, restauration) d'un
-- rattrapage : fusion pièces → sous-structures, liens document ↔ bien,
-- agenda, rattrapage CDC 15. Sert au SUIVI (état, progression, dernier signe
-- de vie), au RAPPORT (synthèse lisible + rapport JSON téléchargeable) et à
-- l'HISTORIQUE. Les rapports détaillés propres à chaque script restent dans
-- leurs tables (room_merge_*, cdc15_migration_*) ; `script_run_id` y renvoie.
--
-- EXCLUSIVITÉ (un seul rattrapage à la fois sur toute la plateforme) :
--   · verrou consultatif de SESSION tenu par l'exécutant pendant toute
--     l'exécution (`verebona:ops-backfill`) — libéré par PostgreSQL si le
--     conteneur s'arrête ;
--   · filet : index UNIQUE partiel ci-dessous — au plus une ligne `running`.
-- Index créé dans ce fichier (table neuve, vide : construction instantanée,
-- aucun verrou sur une table existante).
--
-- Rétrocompatible : table nouvelle, lue seulement par la page BO.
-- Retour arrière : DROP TABLE ops_backfill_runs (aucune autre donnée n'en dépend).
-- Idempotente : IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ops_backfill_runs (
  id              UUID        PRIMARY KEY,
  script          TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  step            TEXT,
  params          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'running',
  reason          TEXT,
  admin_user_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  admin_email     TEXT,
  script_run_id   TEXT,
  progress        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  summary         JSONB,
  report          JSONB,
  error           TEXT,
  owner           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  CONSTRAINT ops_backfill_runs_status_chk CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
  CONSTRAINT ops_backfill_runs_action_chk CHECK (action IN ('simulate', 'apply', 'restore'))
);

COMMENT ON TABLE ops_backfill_runs IS
  'Rattrapages de données lancés depuis le BO « Exploitation » (lot 25) : suivi, rapport, historique. Une seule ligne running à la fois.';

CREATE UNIQUE INDEX IF NOT EXISTS ops_backfill_runs_one_running_uidx
  ON ops_backfill_runs ((true)) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS ops_backfill_runs_started_idx
  ON ops_backfill_runs (started_at DESC);
