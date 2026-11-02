-- Migration 0955 (index 1/2) : lot 103F — « Mes documents », filtre et tri
-- « Date du document » (`document_date`) appliqués côté serveur, sur tout le
-- périmètre du compte, AVANT la pagination par curseur.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la liste lit les documents du compte — plus
-- lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_files_account_document_date_idx
  ON asset_files (account_id, document_date) WHERE deleted_at IS NULL;
