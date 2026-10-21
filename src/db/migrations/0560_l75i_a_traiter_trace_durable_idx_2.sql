-- verebona:optional-index
-- Migration 0560 (index 2/2) : passages d'une décision de famille (agenda,
-- équipements, fournisseurs) — diagnostic BO, cascade de la rétention —
-- lot 75I. UNE instruction par fichier (`CREATE INDEX CONCURRENTLY` hors
-- transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS to_process_evaluation_passages_family_idx
  ON to_process_evaluation_passages (family_decision_id, id DESC) WHERE family_decision_id IS NOT NULL;
