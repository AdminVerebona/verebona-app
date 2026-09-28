-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0210 : journal T6 (mascotte d'accueil) soumis à la politique de
-- rétention du BO IA.
-- CDC Mascotte LOG-006, BO-009 ; CDC BO IA WF-25.
--
-- 1. `home_mascot_generations` rejoint les tables archivées sur S3 au-delà de
--    88 jours complets puis retirées de la base (`log-archive.job.ts`) : le
--    registre `ai_log_archives` doit l'accepter.
-- 2. Index sur `trace_id` : les filtres Exécutions / Coûts (BO-009) relisent
--    le statut de la génération d'un appel par sa trace.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_log_archives DROP CONSTRAINT IF EXISTS ai_log_archives_table_check;
ALTER TABLE ai_log_archives ADD CONSTRAINT ai_log_archives_table_check
  CHECK (source_table IN ('ai_usage_event', 'ai_pipeline_step', 'home_mascot_generations'));

CREATE INDEX IF NOT EXISTS home_mascot_generations_trace_idx
  ON home_mascot_generations (trace_id) WHERE trace_id IS NOT NULL;
