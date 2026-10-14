-- Migration 0345 (index 1/1) : journal des corrections intercomptes (lot 53,
-- retour PO D23) — lecture d'une exécution (restauration, rapport) par son
-- identifiant.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : table de journal, petite ; sans lui la restauration lit
-- la table entière — plus lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS cross_account_remediations_run_idx
  ON cross_account_remediations (run_id, id);
