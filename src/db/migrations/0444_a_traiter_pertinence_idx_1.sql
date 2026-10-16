-- verebona:optional-index
-- Migration 0444 (index 1/1) : décisions « À traiter » différées à
-- réévaluer (lot 61) — campagne de réévaluation et balayage. UNE
-- instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est
-- reconstruit (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_rule_evaluations_reevaluate_idx
  ON document_rule_evaluations (reevaluate_at) WHERE reevaluate_at IS NOT NULL;
