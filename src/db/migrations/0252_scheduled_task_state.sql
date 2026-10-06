-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0252 : état des tâches planifiées internes (lot 25, chantier A).
--
-- Plus aucun planificateur externe : l'application lance elle-même les
-- tâches jusque-là appelées par un cron d'hébergeur (`/api/cron/*`). Chaque
-- tâche a UNE ligne, partagée par toutes les instances :
--
--   next_run_at          prochaine exécution prévue (calendrier Europe/Paris
--                        calculé par l'application) ; NULL = en sommeil
--                        (transfert unique terminé) ;
--   running_run_id /     exécution en cours : identifiant, instance, fin du
--   running_by /         bail. La prise est un seul UPDATE conditionnel
--   running_until        (bail libre ET échéance atteinte) : une seule
--                        exécution à la fois par tâche, quel que soit le
--                        nombre de conteneurs (y compris pendant le
--                        recouvrement d'un déploiement). Un conteneur tué en
--                        cours d'exécution ne bloque rien : le bail expire ;
--   last_*               dernière exécution (début, fin, durée, résultat,
--                        message court sans donnée sensible, instance,
--                        déclencheur : schedule | manual | startup) ;
--   consecutive_failures échecs consécutifs (alerte de Supervision au-delà
--                        d'un seuil pour les tâches critiques).
--
-- Rétrocompatible : nouvelle table, l'ancien code l'ignore. Retour arrière :
-- DROP TABLE scheduled_task_state (aucune autre donnée n'en dépend ; les
-- tâches reprennent leur calendrier au premier tour).
-- Idempotente : IF NOT EXISTS.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS scheduled_task_state (
  code                 TEXT        PRIMARY KEY,
  schedule_signature   TEXT,
  next_run_at          TIMESTAMPTZ,
  running_run_id       TEXT,
  running_by           TEXT,
  running_until        TIMESTAMPTZ,
  last_trigger         TEXT,
  last_started_at      TIMESTAMPTZ,
  last_finished_at     TIMESTAMPTZ,
  last_duration_ms     INTEGER,
  last_status          TEXT,
  last_error           TEXT,
  last_instance        TEXT,
  last_success_at      TIMESTAMPTZ,
  consecutive_failures INTEGER     NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE scheduled_task_state DROP CONSTRAINT IF EXISTS scheduled_task_state_last_status_check;
ALTER TABLE scheduled_task_state ADD CONSTRAINT scheduled_task_state_last_status_check
  CHECK (last_status IS NULL OR last_status IN ('ok', 'error'));

ALTER TABLE scheduled_task_state DROP CONSTRAINT IF EXISTS scheduled_task_state_last_trigger_check;
ALTER TABLE scheduled_task_state ADD CONSTRAINT scheduled_task_state_last_trigger_check
  CHECK (last_trigger IS NULL OR last_trigger IN ('schedule', 'manual', 'startup'));

COMMENT ON TABLE scheduled_task_state IS
  'Tâches planifiées internes : calendrier, exclusivité entre instances (bail), dernière exécution. Lot 25.';
