-- verebona:optional-index
-- Migration 0516 (index 1/1) : dernière décision d'une cible et d'une règle
-- (déduplication, diagnostic BO, rétention) — lot 72C. UNE instruction par
-- fichier (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente ; un
-- index laissé INVALIDE est reconstruit (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS to_process_decisions_target_idx
  ON to_process_decisions (account_id, target_type, target_id, rule_code, id DESC);
