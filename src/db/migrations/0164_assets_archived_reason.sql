-- `assets.archived_reason` est déclarée dans le schéma Drizzle (schema.ts) et
-- écrite à l'acceptation d'une transmission ('transmitted'), mais aucune
-- migration ne la créait. Idempotent : sans effet si la colonne existe déjà.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS archived_reason TEXT;
