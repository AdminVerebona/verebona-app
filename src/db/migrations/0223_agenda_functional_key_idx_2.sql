-- Migration 0223 (index 2/2) : éléments automatiques d'une source — CDC 15
-- T4-08 (synchronisation à la réanalyse). UNE instruction par fichier ;
-- CONCURRENTLY ; idempotente (IF NOT EXISTS).
CREATE INDEX CONCURRENTLY IF NOT EXISTS agenda_items_source_auto_idx ON agenda_items (account_id, origin_ref_id) WHERE origin_ref_type = 'asset_file' AND is_automatic;
