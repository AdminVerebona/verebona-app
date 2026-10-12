-- Migration 0316 (index 1/16) : Opérations actives d'un compte par type et statut (ch. 22.1, C20.1) — lectures T2/T4/TCO et rapprochement borné par compte (NFR-OP-010).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operations_account_active_idx
  ON business_operations (account_id, type_code, status)
  WHERE invalidated_at IS NULL;
