-- =============================================================================
-- 0203 — Plans de commandes : rattachement au message et annulation tracée.
--
-- `message_id` : message de l'assistant qui a présenté le plan. Il permet de
-- restituer l'état du plan (en attente, annulé, expiré, exécuté) dans le fil
-- après un rechargement : une proposition encore en attente reste annulable,
-- une proposition annulée ou expirée ne montre plus de bouton « Confirmer ».
--
-- `cancelled_at` : horodatage de l'annulation par l'utilisateur (la trace
-- détaillée reste dans verebona_command_events).
-- =============================================================================
ALTER TABLE verebona_command_plans ADD COLUMN IF NOT EXISTS message_id INTEGER;
ALTER TABLE verebona_command_plans ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS verebona_command_plans_message_idx
  ON verebona_command_plans (message_id);

-- Expiration des propositions en attente dépassées (lecture et purge).
CREATE INDEX IF NOT EXISTS verebona_command_plans_pending_expiry_idx
  ON verebona_command_plans (expires_at)
  WHERE status = 'PENDING_CONFIRMATION';
