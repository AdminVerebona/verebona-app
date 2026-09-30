-- Migration 0223 (liens source ↔ agenda, index) : un lien par élément,
-- document et rôle, pour les lignes du service de liaison (CDC 15 T4-07,
-- X-04) — les traces historiques (source_role NULL) ne sont pas concernées.
-- UNE instruction par fichier : CREATE INDEX CONCURRENTLY hors transaction ;
-- index invalide après interruption repris au démarrage
-- (`db/migration-index.ts`). Idempotente (IF NOT EXISTS).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agenda_item_sources_link_uidx ON agenda_item_sources (agenda_item_id, asset_file_id, source_role) WHERE source_role IS NOT NULL;
