-- verebona:optional-index
-- Migration 0507 (index 1/1) : reports T6 arrivés à leur date (tâche
-- `mascot-t6-reevaluations`, lot 71G — T6-05). UNE instruction par fichier
-- (CONCURRENTLY hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS t6_reminder_preferences_snooze_due_idx
  ON t6_reminder_preferences (remind_at) WHERE decision = 'SNOOZED';
