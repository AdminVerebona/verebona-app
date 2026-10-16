-- Migration 0435 (index 1/1) : extracts bruts d'un compte en échec de phase
-- (BO, reprise). UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne
-- peut pas s'exécuter dans une transaction. Idempotente ; un index laissé
-- INVALIDE est reconstruit (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la lecture parcourt les extracts du compte — plus
-- lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_raw_extracts_account_idx
  ON document_raw_extracts (account_id, updated_at DESC);
