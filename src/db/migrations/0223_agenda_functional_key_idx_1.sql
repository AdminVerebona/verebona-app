-- Migration 0223 (index 1/2) : unicité de la clé fonctionnelle des éléments
-- AUTOMATIQUES d'un compte — CDC 15 T4-08 (jamais deux éléments pour le même
-- fait d'une même source). UNE instruction par fichier : CREATE INDEX
-- CONCURRENTLY hors transaction ; index invalide après interruption repris au
-- démarrage (`db/migration-index.ts`). Idempotente (IF NOT EXISTS).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agenda_items_functional_key_uidx ON agenda_items (account_id, functional_key) WHERE functional_key IS NOT NULL AND is_automatic;
