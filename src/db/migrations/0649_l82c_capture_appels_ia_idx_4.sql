-- Migration 0649 (index 4/4) : suppression d'utilisateur et effacement de
-- l'historique de l'assistant — lot 82C. UNE instruction par fichier.
-- Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_call_captures_user_idx ON ai_call_captures (user_id) WHERE user_id IS NOT NULL;
