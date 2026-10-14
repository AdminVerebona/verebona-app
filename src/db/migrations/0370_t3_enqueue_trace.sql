-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0370 : trace durable des DEMANDES T3 (phase A — création du job)
-- (lot 54A — ticket « [P1] T3 — Aucun job créé dans la File IA en lancement
-- manuel ni en planification »).
--
--   ai_t3_enqueue_events
--       UNE ligne par demande T3 adressée à la file (lancement manuel,
--       passage planifié échu, événement) : décision (create / skip /
--       coalesce / refused / error), motif (`reason_code` : CROSS_ACCOUNT_SCOPE,
--       DUPLICATE_PENDING, DUPLICATE_RUNNING, ALREADY_QUEUED,
--       NO_ELIGIBLE_ACCOUNT, INSERT_FAILED, PERSISTENCE_NOT_CONFIRMED…), job
--       créé ou absorbant, persistance relue, instance et commit qui ont
--       traité la demande. Une demande qui ne crée AUCUN job laisse donc une
--       trace consultable dans le BO (carte « Supervision T3 ») — sans SQL.
--       Aucune donnée personnelle ni métier (identifiants et codes seulement).
--       Purge des lignes de plus de 30 jours par le boucleur lui-même.
--
--   ai_queue_worker_heartbeats.build_commit / schedule_json
--       Commit du code qui tourne sur chaque instance (le PO voit dans le BO
--       quel code est réellement déployé) et dernière évaluation de la
--       planification par cette instance (SCHEDULE_NOT_DUE, TRIGGER_DISABLED,
--       création…). Les évaluations « non échue » (toutes les 15 s) ne sont
--       PAS journalisées ligne à ligne : seule la dernière est conservée ici.
--
-- Colonnes NULLABLE sans défaut (catalogue seulement). Table neuve : aucun
-- index secondaire (lecture des dernières lignes par clé primaire
-- décroissante, purge bornée). Tables non déclarées dans Drizzle (même choix
-- que 0338) : le code tolère leur absence (trace en journal seulement,
-- supervision « migration 0370 non appliquée »).
-- Idempotente. Retour arrière : DROP TABLE IF EXISTS ai_t3_enqueue_events ;
-- ALTER TABLE ai_queue_worker_heartbeats DROP COLUMN IF EXISTS build_commit,
-- DROP COLUMN IF EXISTS schedule_json (code tolérant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_t3_enqueue_events (
  id            BIGSERIAL   PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin        TEXT        NOT NULL,
  trigger_code  TEXT,
  account_id    INTEGER,
  target_type   TEXT,
  target_id     TEXT,
  decision      TEXT        NOT NULL,
  reason_code   TEXT,
  job_id        INTEGER,
  persisted     BOOLEAN,
  worker_id     TEXT,
  build_commit  TEXT,
  detail        JSONB
);

COMMENT ON TABLE ai_t3_enqueue_events IS
  'Lot 54A : trace de chaque demande T3 adressée à la file IA (phase A — création du job) : décision, motif, job, persistance. BO › File IA › Supervision T3. Purge 30 jours.';

ALTER TABLE IF EXISTS ai_queue_worker_heartbeats ADD COLUMN IF NOT EXISTS build_commit TEXT;
ALTER TABLE IF EXISTS ai_queue_worker_heartbeats ADD COLUMN IF NOT EXISTS schedule_json JSONB;
