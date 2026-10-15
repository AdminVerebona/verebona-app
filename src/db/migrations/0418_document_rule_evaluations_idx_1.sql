-- verebona:optional-index
-- Migration 0418 (index 1/1) : diagnostic par règle documentaire (lot 58B) —
-- dernière évaluation d'une règle sur un document (mémoire de pertinence,
-- filtre « document » du BO). UNE instruction par fichier : `CREATE INDEX
-- CONCURRENTLY` ne s'exécute pas dans une transaction. Idempotente ; un index
-- laissé INVALIDE est reconstruit (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_rule_evaluations_file_rule_idx
  ON document_rule_evaluations (account_id, file_id, rule_code, id DESC);
