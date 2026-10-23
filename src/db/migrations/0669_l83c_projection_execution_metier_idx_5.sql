-- Migration 0669 (index 5/7) : réponse de l'assistant d'une demande T2
-- (niveau d'étayage, issue de la demande) — lot 83C. UNE instruction.
-- Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS verebona_messages_assistant_request_idx ON verebona_messages (request_id) WHERE role = 'assistant';
