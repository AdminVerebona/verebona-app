-- Migration 0840 (index 1/1) : ticket d'ouverture app → navigateur système (lot 97B).
-- UNE instruction par fichier (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : petite table purgée chaque jour ; unicité garantie par le
-- tirage aléatoire (32 octets). Sans lui : lecture séquentielle.
-- verebona:optional-index
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS auth_transactions_app_ticket_uq
  ON auth_transactions (app_ticket_hash) WHERE app_ticket_hash IS NOT NULL;
