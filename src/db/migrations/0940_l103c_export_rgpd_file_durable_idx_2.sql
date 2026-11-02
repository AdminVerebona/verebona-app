-- Migration 0940 (index 2/2) : file des générations RGPD à prendre (worker).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente.
--
-- INDEX OPTIONNEL : sans lui, la prise parcourt la table — plus lent,
-- jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS gdpr_exports_queue_idx
  ON gdpr_exports (created_at, id) WHERE status IN ('pending', 'generating');
