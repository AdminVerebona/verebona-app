-- verebona:optional-index
-- Migration 0410 (index 1/2) : diagnostic BO des « À traiter » T3 (lot 57B)
-- — lecture du journal par job de file (filtre « job » de l'écran File IA).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est
-- reconstruit (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS t3_open_action_evaluations_job_idx
  ON t3_open_action_evaluations (queue_job_id) WHERE queue_job_id IS NOT NULL;
