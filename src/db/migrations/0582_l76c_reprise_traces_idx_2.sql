-- verebona:optional-index
-- Migration 0582 (index 2/2) : traces non écrites d'un compte (diagnostic BO,
-- filtre compte) — lot 76C (C8). UNE instruction par fichier. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS to_process_trace_retries_account_idx
  ON to_process_trace_retries (account_id, id DESC);
