-- Migration 0736 (index 1/1) : au plus UNE décision active par lien Document ↔
-- Agenda (objet AGENDA_FILE_LINK, sans Opération) — l'index unique existant
-- (`business_operation_match_decisions_active_uidx`) porte sur l'Opération et
-- ne s'applique pas aux lignes sans Opération (NULL distincts).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS business_operation_match_decisions_link_active_uidx
  ON business_operation_match_decisions (account_id, source_kind, source_entity_key)
  WHERE active AND candidate_operation_id IS NULL;
