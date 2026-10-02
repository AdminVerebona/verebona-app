-- Migration 0229 (index 2/3) : document_asset_links — unicité d'un lien ACTIF
-- par (document, bien, pièce historique, équipement, SOUS-STRUCTURE) (D-G, lot 20).
-- Remplace document_asset_links_active_uniq (supprimé par idx 3/3, APRÈS) :
-- l'ancien ignorait la sous-structure, deux pièces d'un même document
-- seraient entrées en conflit.
-- UNE instruction par fichier (CONCURRENTLY, hors transaction). Idempotente.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS document_asset_links_active_uniq2 ON document_asset_links (file_id, COALESCE(asset_id, 0), COALESCE(room_id, 0), COALESCE(equipment_id, 0), COALESCE(substructure_id, 0)) WHERE status = 'ACTIVE';
