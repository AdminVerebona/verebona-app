-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0148 — Une seule attribution de cadeau par événement de parrainage
--
-- L'ordre était : report de l'échéance chez Stripe, PUIS `rewarded_at` en
-- base. Une panne entre les deux, ou deux exécutions concurrentes du cron,
-- et le mois était offert deux fois.
--
--   · reward_key       : identifiant stable de LA récompense (dérivé de
--                        l'événement), aussi posé chez Stripe ;
--   · reward_status    : reward_processing → reward_applied ;
--   · reward_claim_*   : prise exclusive, atomique, avant tout appel Stripe ;
--                        une prise abandonnée (processus arrêté) est reprise
--                        après expiration.
-- Plusieurs événements légitimes donnent chacun un mois ; le même événement
-- rejoué, jamais deux.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE referral_events ADD COLUMN IF NOT EXISTS reward_key          TEXT;
ALTER TABLE referral_events ADD COLUMN IF NOT EXISTS reward_status       TEXT;
ALTER TABLE referral_events ADD COLUMN IF NOT EXISTS reward_claim_token  UUID;
ALTER TABLE referral_events ADD COLUMN IF NOT EXISTS reward_claimed_at   TIMESTAMPTZ;
ALTER TABLE referral_events ADD COLUMN IF NOT EXISTS reward_applied_at   TIMESTAMPTZ;
ALTER TABLE referral_events ADD COLUMN IF NOT EXISTS reward_period_end   TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS referral_events_reward_key_uidx
  ON referral_events (reward_key) WHERE reward_key IS NOT NULL;

-- Événements déjà récompensés : réputés appliqués.
UPDATE referral_events
   SET reward_status = 'reward_applied',
       reward_key = COALESCE(reward_key, 'referral-reward-' || id),
       reward_applied_at = COALESCE(reward_applied_at, rewarded_at)
 WHERE rewarded_at IS NOT NULL AND reward_status IS NULL;
