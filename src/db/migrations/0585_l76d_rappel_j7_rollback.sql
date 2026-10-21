-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0585 : rappel J−7 des abonnements annuels — retour aux rappels
-- Stripe fiabilisé et erreurs de réconciliation persistées (lot 76D, ticket P1
-- « Rappel annuel J−7 — risques résiduels de doublon et rollback »).
--
--   1. transactional_email_jobs.neutralized_at : instant où le retour arrière a
--      NEUTRALISÉ la demande. Une demande neutralisée n'est plus jamais prise
--      par la file (ni reprise, ni verrou expiré, ni bascule redéclarée) ; son
--      issue chez le prestataire (provider_outcome, uncertain_since…) est
--      CONSERVÉE : la neutralisation arrête l'émission, elle ne qualifie pas
--      l'appel déjà effectué.
--   2. annual_renewal_reminder_state : phase EXPLICITE du retour arrière
--      (`in_progress` → `completed`), fin (automatique ou arbitrage BO), dernier
--      contrôle et résumé (compteurs, éléments bloquants).
--   3. annual_renewal_reminder_checks : `renewal_date_verified` (échéance
--      locale non revérifiée chez Stripe) ; nouveaux résultats RECONCILE_ERROR
--      (relecture Stripe en échec dans le parcours inverse de la réconciliation)
--      et RECONCILE_RESOLVED (reprise réussie, historique conservé).
--   4. Reprise des retours arrière ANTÉRIEURS (lot 72F) : les demandes déjà
--      neutralisées sont marquées ; celles dont l'acceptation était incertaine
--      redeviennent « acceptation incertaine » (visibles et arbitrables dans le
--      BO, jamais réémises) ; un retour arrière antérieur non suivi d'une
--      nouvelle bascule repasse « en cours » (finalisé automatiquement au
--      contrôle suivant s'il ne reste rien à résoudre).
--
-- Idempotente (IF NOT EXISTS, contraintes remplacées, mises à jour gardées).
-- Retour arrière du code : l'ancien code ignore les colonnes ajoutées.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE transactional_email_jobs ADD COLUMN IF NOT EXISTS neutralized_at timestamptz;

ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS rollback_status text;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS rollback_completed_at timestamptz;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS rollback_completed_by integer;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS rollback_completion_mode text;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS rollback_last_check_at timestamptz;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS rollback_summary jsonb;

ALTER TABLE annual_renewal_reminder_state DROP CONSTRAINT IF EXISTS annual_renewal_reminder_state_rollback_status_check;
ALTER TABLE annual_renewal_reminder_state ADD CONSTRAINT annual_renewal_reminder_state_rollback_status_check
  CHECK (rollback_status IS NULL OR rollback_status IN ('in_progress', 'completed'));

ALTER TABLE annual_renewal_reminder_checks ADD COLUMN IF NOT EXISTS renewal_date_verified boolean NOT NULL DEFAULT true;

ALTER TABLE annual_renewal_reminder_checks DROP CONSTRAINT IF EXISTS annual_renewal_reminder_checks_outcome_check;
ALTER TABLE annual_renewal_reminder_checks ADD CONSTRAINT annual_renewal_reminder_checks_outcome_check
  CHECK (outcome IN ('ENQUEUED', 'REVIVED', 'DUPLICATE', 'WAITING', 'EXCLUDED', 'NO_RECIPIENT',
                     'STRIPE_ERROR', 'COVERAGE_UNCERTAIN', 'DESYNC_RESYNCED', 'DESYNC_UNRESOLVED', 'STRIPE_ONLY',
                     'RECONCILE_ERROR', 'RECONCILE_RESOLVED'));

-- 4. Retours arrière antérieurs (lot 72F).
UPDATE transactional_email_jobs
   SET neutralized_at = updated_at
 WHERE kind = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' AND last_error = 'ROLLBACK_NEUTRALIZED' AND neutralized_at IS NULL;

UPDATE transactional_email_jobs
   SET status = 'uncertain', last_error = 'ROLLBACK_UNCERTAIN', uncertain_since = COALESCE(uncertain_since, updated_at)
 WHERE kind = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' AND status = 'cancelled' AND last_error = 'ROLLBACK_NEUTRALIZED'
   AND (provider_outcome = 'uncertain' OR provider_call_started_at IS NOT NULL);

UPDATE annual_renewal_reminder_state
   SET rollback_status = 'in_progress'
 WHERE id = 1 AND rollback_at IS NOT NULL AND stripe_reminders_disabled_at IS NULL AND rollback_status IS NULL;
