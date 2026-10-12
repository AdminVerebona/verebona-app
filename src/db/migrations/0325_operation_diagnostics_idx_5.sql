-- Migration 0325 (index 5/6) : BO diagnostic des Opérations (lot 47A, O9) —
-- indicateur C26.2 « % documents T1 produisant >= 1 candidat certain » sur la
-- période (date d'analyse).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_extractions_extracted_idx
  ON document_extractions (extracted_at);
