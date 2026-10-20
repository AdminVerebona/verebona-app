-- verebona:optional-index
-- Migration 0517 (index 1/1) : une issue par décision SANS carte, par
-- campagne (lot 72C, C6) — rejouer un lot ne crée aucun doublon. UNE
-- instruction par fichier (CONCURRENTLY hors transaction). Idempotente.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS to_process_relevance_campaign_items_decision_uniq
  ON to_process_relevance_campaign_items (campaign_id, target_type, target_id, rule_code) WHERE action_id IS NULL;
