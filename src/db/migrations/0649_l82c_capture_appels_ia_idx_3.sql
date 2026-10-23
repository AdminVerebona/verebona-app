-- Migration 0649 (index 3/4) : suppression de compte (contrôle des orphelins
-- de `executeScheduledDeletion`) sans parcours complet de la table — lot 82C.
-- UNE instruction par fichier. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_call_captures_account_idx ON ai_call_captures (account_id) WHERE account_id IS NOT NULL;
