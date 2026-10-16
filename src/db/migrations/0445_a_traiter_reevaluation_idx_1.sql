-- verebona:optional-index
-- Migration 0445 (index 1/1) : issues d'une campagne de réévaluation par
-- compte (filtre du BO). UNE instruction par fichier (CONCURRENTLY hors
-- transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS to_process_relevance_campaign_items_account_idx
  ON to_process_relevance_campaign_items (account_id, campaign_id);
