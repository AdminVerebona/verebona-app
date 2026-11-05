-- Migration 1196 (index 1/1) : générations actives d'un même dossier (lot
-- 111B, recherche de la régénération sous le verrou du compte). UNE
-- instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas dans
-- une transaction. Idempotente.
--
-- INDEX OPTIONNEL : sans lui, la recherche passe par l'index `account_id` —
-- plus lent, jamais faux. L'absence de double remplacement est garantie par
-- le verrou consultatif par compte (`enqueueGeneration`), pas par un index.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS export_generation_identity_active_idx
  ON export_generation (account_id, identity_key)
  WHERE status IN ('queued', 'generating') AND identity_key IS NOT NULL;
