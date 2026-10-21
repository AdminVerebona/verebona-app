-- verebona:optional-index
-- Migration 0581 (index 1/1) : éléments d'une campagne « À traiter » restant
-- en erreur (reprise bornée, bilan BO) — lot 76C (C7). UNE instruction par
-- fichier (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente ; un
-- index laissé INVALIDE est reconstruit (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS to_process_relevance_campaign_items_errors_idx
  ON to_process_relevance_campaign_items (campaign_id, retry_after) WHERE last_error IS NOT NULL;
