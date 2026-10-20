-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0524 : fiabilisation du rappel J−7 des abonnements annuels (lot 72F,
-- ticket P1 « Abonnements annuels — Fiabiliser le rappel J−7 avant renouvellement »).
--
--   1. transactional_email_jobs — identité d'envoi STABLE entre les tentatives :
--        · send_generation : la clé Resend est `vb-email-job-<id>-g<génération>` ;
--          elle ne change qu'après un refus CONFIRMÉ du prestataire (jamais après
--          une réponse perdue, un arrêt du processus ou une erreur 5xx) ;
--        · provider_call_started_at : premier appel au prestataire avec cette clé
--          (fenêtre d'idempotence Resend : 24 h) ;
--        · provider_outcome / provider_detail : dernier résultat du prestataire
--          (accepted, rejected, uncertain, reconciled, admin_confirmed…) et sa cause
--          technique (code, statut HTTP — jamais de destinataire ni de secret) ;
--        · uncertain_since : début d'une acceptation incertaine ;
--        · statut `uncertain` : acceptation incertaine NON résolue — réémission
--          automatique BLOQUÉE, anomalie visible dans le BO (action manuelle).
--   2. email_provider_events.email_job_id : demande d'origine lue dans les
--      étiquettes (tags) du webhook Resend (réconciliation sans identifiant).
--   3. annual_renewal_reminder_state — bascule Stripe → Verebona DÉCLARÉE :
--      instant de désactivation des rappels Stripe (sans elle : aucun rappel
--      Verebona préparé ni envoyé), dernier retour arrière, réconciliation.
--   4. annual_renewal_reminder_checks — journal par vérification : étape, dernier
--      contrôle, prochaine vérification, historique borné ; nouveaux résultats
--      (erreur Stripe, couverture incertaine, désynchronisations) ; compte
--      facultatif (abonnement Stripe absent localement).
--   5. tâche `subscription-annual-renewal-reconcile` créée SUSPENDUE (activée à
--      la bascule, avec le rappel).
--
-- Idempotente (IF NOT EXISTS, contraintes remplacées, ON CONFLICT DO NOTHING).
-- Retour arrière : l'ancien code ignore les colonnes ajoutées ; une demande au
-- statut `uncertain` n'est jamais reprise par lui (statut hors de sa sélection).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE transactional_email_jobs ADD COLUMN IF NOT EXISTS send_generation integer NOT NULL DEFAULT 0;
ALTER TABLE transactional_email_jobs ADD COLUMN IF NOT EXISTS provider_call_started_at timestamptz;
ALTER TABLE transactional_email_jobs ADD COLUMN IF NOT EXISTS provider_outcome text;
ALTER TABLE transactional_email_jobs ADD COLUMN IF NOT EXISTS provider_detail text;
ALTER TABLE transactional_email_jobs ADD COLUMN IF NOT EXISTS uncertain_since timestamptz;

ALTER TABLE transactional_email_jobs DROP CONSTRAINT IF EXISTS transactional_email_jobs_status_check;
ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_status_check
  CHECK (status IN ('pending', 'sending', 'accepted', 'failed', 'cancelled', 'uncertain'));

ALTER TABLE email_provider_events ADD COLUMN IF NOT EXISTS email_job_id integer;

ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS stripe_reminders_disabled_at timestamptz;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS switch_declared_at timestamptz;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS switch_declared_by integer;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS rollback_at timestamptz;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS rollback_by integer;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS last_reconcile_at timestamptz;
ALTER TABLE annual_renewal_reminder_state ADD COLUMN IF NOT EXISTS last_reconcile_note text;

ALTER TABLE annual_renewal_reminder_checks ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE annual_renewal_reminder_checks ADD COLUMN IF NOT EXISTS step text;
ALTER TABLE annual_renewal_reminder_checks ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
ALTER TABLE annual_renewal_reminder_checks ADD COLUMN IF NOT EXISTS next_check_at timestamptz;
ALTER TABLE annual_renewal_reminder_checks ADD COLUMN IF NOT EXISTS history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE annual_renewal_reminder_checks DROP CONSTRAINT IF EXISTS annual_renewal_reminder_checks_outcome_check;
ALTER TABLE annual_renewal_reminder_checks ADD CONSTRAINT annual_renewal_reminder_checks_outcome_check
  CHECK (outcome IN ('ENQUEUED', 'REVIVED', 'DUPLICATE', 'WAITING', 'EXCLUDED', 'NO_RECIPIENT',
                     'STRIPE_ERROR', 'COVERAGE_UNCERTAIN', 'DESYNC_RESYNCED', 'DESYNC_UNRESOLVED', 'STRIPE_ONLY'));

INSERT INTO scheduled_task_state (code, admin_disabled, admin_disabled_at, last_note, created_at, updated_at)
VALUES ('subscription-annual-renewal-reconcile', true, now(),
        'Créée suspendue (lot 72F) : à réactiver avec le rappel J−7 au moment de la bascule des rappels Stripe vers Verebona.', now(), now())
ON CONFLICT (code) DO NOTHING;
