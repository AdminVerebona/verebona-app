-- Migration 0325 (index 1/6) : BO diagnostic des Opérations (lot 47A, O9 — CDC
-- Opérations V1 C26.1, C26.2). Liste globale triée par date de création et
-- indicateurs de la période (créations par jour, cohortes fusion /
-- invalidation à 7 jours) — `OperationDiagnosticsService`.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operations_created_idx
  ON business_operations (created_at);
