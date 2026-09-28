-- =============================================================================
-- 0205 — Index sur la question de l'utilisateur par demande (CDC §10.4).
--
-- La vue BO « questions d'aide sans réponse » rapproche chaque demande
-- (`verebona_request_runs.request_id`) de la question posée
-- (`verebona_messages`, role = 'user'). Sans index sur `request_id`, la
-- jointure parcourait toute la table des messages. Index partiel : seules
-- les questions de l'utilisateur sont rapprochées. Idempotent.
-- =============================================================================
CREATE INDEX IF NOT EXISTS verebona_messages_user_request_idx
  ON verebona_messages (request_id)
  WHERE role = 'user';
