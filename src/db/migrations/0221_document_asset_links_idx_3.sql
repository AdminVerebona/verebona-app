-- Migration 0221 (index 3/3) : liens d'un compte (contrôles, rapport de rattrapage) — CDC 15 X-01.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_asset_links_account_idx ON document_asset_links (account_id, status);
