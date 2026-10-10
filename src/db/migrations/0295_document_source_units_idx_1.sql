-- Migration 0295 (index 1/2) : unités à réinterpréter d'un compte (T3, reprises :
-- UNRESOLVED, UNCERTAIN, FAILED). UNE instruction par fichier : `CREATE INDEX
-- CONCURRENTLY` ne peut pas s'exécuter dans une transaction. Idempotente ; un
-- index laissé INVALIDE est reconstruit (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la lecture parcourt les unités du compte — plus
-- lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_source_units_account_open_idx
  ON document_source_units (account_id, coverage_status, file_id)
  WHERE coverage_status IN ('UNRESOLVED', 'UNCERTAIN', 'FAILED');
