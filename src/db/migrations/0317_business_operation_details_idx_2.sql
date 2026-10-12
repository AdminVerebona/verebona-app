-- Migration 0317 (index 2/10) : Candidats actifs d'un compte (balayage T3).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_operation_candidates_account_active_idx
  ON document_operation_candidates (account_id, created_at)
  WHERE status = 'ACTIVE';
