-- Migration 0672 (index 1/1) : journal du nettoyage Sinistres lu par exécution (restauration, rapport).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la restauration parcourt davantage de lignes —
-- plus lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS claim_legacy_cleanup_journal_run_idx
  ON claim_legacy_cleanup_journal (run_id, id);
