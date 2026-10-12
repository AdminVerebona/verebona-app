-- Migration 0320 (index 2/2) : candidats en attente de T3 (balayage, C4 TRG-020).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_operation_candidates_t3_pending_idx
  ON document_operation_candidates (account_id, created_at)
  WHERE t3_pending;
