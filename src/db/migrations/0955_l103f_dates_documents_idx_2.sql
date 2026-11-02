-- Migration 0955 (index 2/2) : lot 103F — « Mes documents », filtre « Date
-- d'ajout » (`uploaded_at`, horodatage serveur d'entrée) et tri par défaut
-- (date d'ajout décroissante), côté serveur, AVANT la pagination par curseur.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la liste lit les documents du compte — plus
-- lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_files_account_uploaded_at_idx
  ON asset_files (account_id, uploaded_at) WHERE deleted_at IS NULL;
