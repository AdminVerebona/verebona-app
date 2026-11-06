-- Migration 1531 (index 1/2) : traçabilité des propriétés du diagnostic BO —
-- lot 113Q (ticket Trello #714). UNE instruction par fichier : `CREATE INDEX
-- CONCURRENTLY` ne s'exécute pas dans une transaction. Idempotente.
--
-- Rapports d'exécution d'un BIEN (`asset_id`) : lus pour chaque bien par la
-- traçabilité des propriétés (rapports T3 du bien, travaux de la file) —
-- aucun index ne couvrait `asset_id` (parcours de toute la table pour chaque
-- bien du diagnostic global).
--
-- INDEX OPTIONNEL : sans lui, la lecture parcourt la table — plus lent,
-- jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_execution_reports_account_asset_idx
  ON ai_execution_reports (account_id, asset_id) WHERE asset_id IS NOT NULL;
