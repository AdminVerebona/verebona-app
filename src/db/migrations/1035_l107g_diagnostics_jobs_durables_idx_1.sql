-- Migration 1035 (index 1/1) : file des diagnostics BO à prendre (worker) —
-- lot 107G. UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne
-- s'exécute pas dans une transaction. Idempotente.
--
-- INDEX OPTIONNEL : sans lui, la prise parcourt la table (petite) — plus
-- lent, jamais faux. L'unicité d'une demande (double clic) est garantie par
-- un verrou consultatif (`enqueueDiagnosticJob`), pas par un index.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS admin_export_generations_jobs_idx
  ON admin_export_generations (status, next_attempt_at, started_at)
  WHERE mode = 'job' AND status IN ('QUEUED', 'RUNNING');
