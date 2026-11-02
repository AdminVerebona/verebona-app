-- Migration 0960 (index 1/1) : au plus UN compte technique de qualification
-- (`accounts.technical_kind`). UNE instruction par fichier : `CREATE INDEX
-- CONCURRENTLY` ne s'exécute pas dans une transaction. Idempotente ; un index
-- laissé INVALIDE est reconstruit (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, l'unicité reste garantie par le verrou
-- consultatif du provisionnement et contrôlée par le précontrôle des campagnes
-- (doublon → CORPUS_ACCOUNT_INVALID, campagne refusée).
-- verebona:optional-index
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS accounts_technical_kind_uniq
  ON accounts (technical_kind) WHERE technical_kind IS NOT NULL;
