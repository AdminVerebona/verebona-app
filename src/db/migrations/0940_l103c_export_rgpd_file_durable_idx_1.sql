-- Migration 0940 (index 1/2) : clé d'idempotence d'une demande d'export RGPD,
-- unique par utilisateur (double clic, POST rejoué après une perte réseau).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, l'unicité reste garantie par le verrou
-- consultatif par utilisateur pris à la demande (`requestGdprExport`).
-- verebona:optional-index
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS gdpr_exports_client_key_idx
  ON gdpr_exports (user_id, client_request_key) WHERE client_request_key IS NOT NULL;
