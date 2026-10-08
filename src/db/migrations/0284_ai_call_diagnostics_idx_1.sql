-- Migration 0284 (index 1/3) : diagnostics d'une exécution, par trace (détail
-- BO « Exécutions & logs », export). UNE instruction par fichier :
-- `CREATE INDEX CONCURRENTLY` ne peut pas s'exécuter dans une transaction.
-- Idempotente ; un index laissé INVALIDE est reconstruit (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, le détail d'une exécution parcourt la table
-- (bornée par la purge à 88 jours) — plus lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_call_diagnostics_trace_idx ON ai_call_diagnostics (trace_id, call_index);
