-- verebona:optional-index
-- Migration 0597 (index 1/1) : biens d'un compte par version de contrôle
-- (rattrapage automatique borné du stock) — lot 76J. UNE instruction par
-- fichier (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS t3_information_checks_account_version_idx
  ON t3_information_checks (account_id, check_version);
