-- verebona:optional-index
-- Migration 0432 (index 2/2) : évaluations T6 d'une échéance (suppression
-- en cascade). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS t6_interpellation_assessments_agenda_idx
  ON t6_interpellation_assessments (agenda_item_id);
