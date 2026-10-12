-- Migration 0317 (index 3/10) : Décisions de rapprochement d'une source (C20.1, C6.3).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_match_decisions_source_idx
  ON business_operation_match_decisions (account_id, source_kind, source_entity_key)
  WHERE active;
