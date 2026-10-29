-- Migration 0856 (index 1/1) : mémoire des décisions T3 — lecture et suppression
-- par bien (suppression en cascade d'un bien, transfert de compte, diagnostic).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la suppression d'un bien parcourt la table — plus
-- lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS t3_decision_memory_asset_idx
  ON t3_decision_memory (asset_id, field_key);
