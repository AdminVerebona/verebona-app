-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1280 : diagnostic CIBLÉ en file — voie réservée aux diagnostics
-- ciblés, métriques d'attente / d'exécution séparées, profilage par étape
-- (lot 111Q, ticket P1 du 05/11/2026 : « account #13 · renforcé »
-- f191d635… resté EN FILE 6 min, 0/3, aucun worker). Prolonge la 1200 (111C).
--
-- 1. `admin_export_generations` (file durable des diagnostics, lot 107G) :
--      first_run_started_at  PREMIER démarrage réel (prise par un worker) —
--                            `run_started_at` est réécrit à chaque tentative :
--                            temps en file = first_run_started_at − started_at ;
--      lane                  voie qui a pris la demande (`main` : voie
--                            commune ; `targeted` : voie réservée aux ciblés) ;
--      phase_timings         profilage de la tentative (durée de chaque étape,
--                            fichiers les plus lents, métriques finales) —
--                            aucune donnée métier, seulement des chemins de
--                            fichiers du ZIP et des durées.
--
-- 2. `diagnostic_worker_heartbeats` (1200) : état de la VOIE CIBLÉE de chaque
--    processus (travail en cours, raison d'attente, dernier prélèvement) —
--    lu par le superviseur et le BO pour dire pourquoi un ciblé attend.
--
-- Additive, idempotente, rejouable. Retour arrière : les colonnes peuvent
-- rester (le code des lots 110 et 111C les ignore).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS first_run_started_at TIMESTAMPTZ;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS lane TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS phase_timings JSONB;

-- Reprise de l'existant : premier démarrage connu = début de la première tentative journalisée.
UPDATE admin_export_generations
   SET first_run_started_at = (attempts_log->0->>'startedAt')::timestamptz
 WHERE first_run_started_at IS NULL AND kind = 'TECH_DIAGNOSTIC' AND mode = 'job'
   AND jsonb_typeof(attempts_log) = 'array' AND jsonb_array_length(attempts_log) > 0
   AND (attempts_log->0->>'startedAt') ~ '^\d{4}-\d{2}-\d{2}T';

ALTER TABLE diagnostic_worker_heartbeats ADD COLUMN IF NOT EXISTS lane_job_id UUID;
ALTER TABLE diagnostic_worker_heartbeats ADD COLUMN IF NOT EXISTS lane_wait_reason TEXT;
ALTER TABLE diagnostic_worker_heartbeats ADD COLUMN IF NOT EXISTS lane_last_claim_at TIMESTAMPTZ;
ALTER TABLE diagnostic_worker_heartbeats ADD COLUMN IF NOT EXISTS lane_capacity INTEGER;
