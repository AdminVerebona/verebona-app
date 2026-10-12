-- Migration 0325 (index 6/6) : BO diagnostic des Opérations (lot 47A, O9) —
-- indicateur C26.2 « T2 réponses économiques Operation-only / mixtes /
-- fallback-only » : demandes dont la trace porte `observability.economicMode`
-- (index partiel : les seules réponses économiques).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS verebona_request_runs_economic_idx
  ON verebona_request_runs (created_at)
  WHERE ((retrieval_methods_json -> 'observability' ->> 'economicMode') IS NOT NULL);
