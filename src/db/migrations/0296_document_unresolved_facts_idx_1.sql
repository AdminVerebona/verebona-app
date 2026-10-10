-- Migration 0296 (index 1/1) : faits non résolus d'un document (lecture par
-- fichier, remplacement à la réanalyse). UNE instruction par fichier
-- (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : sans lui, la lecture et le remplacement parcourent la
-- table — plus lents, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_unresolved_facts_file_idx
  ON document_unresolved_facts (file_id, status);
