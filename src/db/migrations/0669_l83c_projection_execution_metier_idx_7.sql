-- Migration 0669 (index 7/7) : couvertures T1 modifiées par période (reprise
-- ciblée sans nouvelle analyse : l'issue de la dernière exécution du document
-- peut changer) — lot 83C. UNE instruction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_extraction_coverage_updated_idx ON document_extraction_coverage (updated_at);
