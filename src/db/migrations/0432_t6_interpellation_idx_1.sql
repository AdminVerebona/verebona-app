-- verebona:optional-index
-- Migration 0432 (index 1/2) : préférences de rappel d'une échéance
-- (suppression en cascade, détail de l'échéance). UNE instruction par
-- fichier (CONCURRENTLY hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS t6_reminder_preferences_agenda_idx
  ON t6_reminder_preferences (agenda_item_id) WHERE agenda_item_id IS NOT NULL;
