-- Migration 1531 (index 2/2) : traçabilité des propriétés du diagnostic BO —
-- lot 113Q (ticket Trello #714). UNE instruction par fichier : `CREATE INDEX
-- CONCURRENTLY` ne s'exécute pas dans une transaction. Idempotente.
--
-- Reprises de propriétés manquantes d'un BIEN (`asset_id`) : lues pour chaque
-- bien par la traçabilité des propriétés ; l'index existant commence par
-- (account_id, object_type…) et ne sert pas la lecture par bien.
--
-- INDEX OPTIONNEL : sans lui, la lecture parcourt la table — plus lent,
-- jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS property_recovery_decisions_account_asset_idx
  ON property_recovery_decisions (account_id, asset_id);
