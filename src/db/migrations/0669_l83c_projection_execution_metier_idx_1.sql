-- Migration 0669 (index 1/7) — projection « exécution métier » calculée à la
-- lecture depuis les états natifs (aucune table, aucune colonne) : index de
-- lecture seulement. Travaux de file par traitement et dernière
-- activité (fin, sinon début, sinon mise en file) — période des exécutions
-- métier T1/T3/T4 (SEM-02, BO-05) — lot 83C. UNE instruction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_job_queue_activity_idx ON ai_job_queue (treatment, (COALESCE(finished_at, started_at, created_at)));
