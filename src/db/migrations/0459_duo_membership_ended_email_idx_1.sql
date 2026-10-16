-- verebona:optional-index
-- Migration 0459 (index 1/1) : unicité des envois « une fois par événement » (lot 64A).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
-- Facultatif : l'enregistrement est déjà sérialisé (verrou consultatif + NOT EXISTS).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS transactional_email_jobs_dedupe_key_idx
  ON transactional_email_jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
