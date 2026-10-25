-- Migration 0752 (index 1/1) : réévaluations d'une Opération par portée, les
-- plus récentes d'abord (mémoire anti-rappel, budget du compte sur 24 h,
-- diagnostics BO). UNE instruction par fichier : `CREATE INDEX CONCURRENTLY`
-- ne s'exécute pas dans une transaction. Idempotente ; un index laissé
-- INVALIDE est reconstruit (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la mémoire et le budget parcourent davantage de
-- lignes — plus lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS operation_semantic_reevaluations_lookup_idx
  ON operation_semantic_reevaluations (account_id, scope, operation_id, created_at DESC);
