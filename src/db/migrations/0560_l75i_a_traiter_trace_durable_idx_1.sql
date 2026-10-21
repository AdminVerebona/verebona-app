-- verebona:optional-index
-- Migration 0560 (index 1/2) : passages d'une évaluation de règle documentaire
-- (diagnostic BO, cascade de la rétention) — lot 75I. UNE instruction par
-- fichier (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente ; un
-- index laissé INVALIDE est reconstruit (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS to_process_evaluation_passages_rule_idx
  ON to_process_evaluation_passages (rule_evaluation_id, id DESC) WHERE rule_evaluation_id IS NOT NULL;
