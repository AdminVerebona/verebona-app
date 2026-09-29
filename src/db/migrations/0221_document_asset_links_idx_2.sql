-- Migration 0221 (index 2/3) : documents d'un bien (`listAssetDocuments`), liens actifs — CDC 15 X-01.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_asset_links_asset_idx ON document_asset_links (asset_id, file_id) WHERE status = 'ACTIVE' AND asset_id IS NOT NULL;
