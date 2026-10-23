-- Migration 0669 (index 6/7) : générations T6 FORMULATE tracées par date
-- (période des exécutions métier T6) — lot 83C. UNE instruction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS home_mascot_generations_traced_idx ON home_mascot_generations (created_at) WHERE trace_id IS NOT NULL;
