-- Migration 0221 (index 1/3) : unicité d'un lien ACTIF par (document, cible) — CDC 15 X-01.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction (voir 0218_*_idx_1.sql pour la reprise d'un index
-- invalide). COALESCE : NULL ≠ NULL dans un index unique ; la cible
-- (bien, pièce, équipement) est comparée avec 0 pour « absent », sans
-- dépendre de NULLS NOT DISTINCT (PostgreSQL 15+). Sert aussi les lectures
-- par document (colonne de tête `file_id`).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS document_asset_links_active_uniq ON document_asset_links (file_id, COALESCE(asset_id, 0), COALESCE(room_id, 0), COALESCE(equipment_id, 0)) WHERE status = 'ACTIVE';
