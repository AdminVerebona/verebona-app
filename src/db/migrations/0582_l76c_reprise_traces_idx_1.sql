-- verebona:optional-index
-- Migration 0582 (index 1/2) : traces à rejouer (reprise automatique bornée) —
-- lot 76C (C8). UNE instruction par fichier (`CREATE INDEX CONCURRENTLY` hors
-- transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS to_process_trace_retries_pending_idx
  ON to_process_trace_retries (next_attempt_at, id) WHERE status = 'PENDING';
