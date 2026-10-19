-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0477 : rappel J−7 avant le renouvellement d'un abonnement ANNUEL
-- (lot 68C, ticket P1 « Abonnements annuels — e-mail automatique à J−7 »).
--
-- Verebona envoie désormais lui-même le rappel de renouvellement des seuls
-- abonnements annuels (Stripe reste la source des données de facturation) :
--
--   1. transactional_email_jobs.kind accepte SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER
--      (file DURABLE du lot 57A ; idempotence par dedupe_key de la 0459 :
--      « annual-renewal-reminder:<abonnement Stripe>:<date d'échéance> ») ;
--   2. gabarit SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER créé s'il manque (texte du
--      ticket ; mise en page de la charte par l'enveloppe du code ; jamais
--      écrasé s'il existe déjà) — même texte que src/lib/email-defaults.ts ;
--   3. annual_renewal_reminder_state : début de couverture (date de la PREMIÈRE
--      exécution du traitement) — aucun rattrapage d'une échéance dont le J−7
--      précède l'activation (rappel Stripe déjà parti à la bascule) ;
--   4. annual_renewal_reminder_checks : journal des décisions du traitement
--      (envoi préparé, attente, exclusion et motif), une ligne par abonnement ×
--      échéance, vérifiée au plus une fois par jour chez Stripe ;
--   5. tâche planifiée `subscription-annual-renewal-reminders` créée SUSPENDUE :
--      elle est activée depuis le BO › Exploitation › Tâches planifiées
--      (« Réactiver ») au moment de la bascule — jamais de double rappel avec
--      Stripe avant que l'option Stripe ne soit désactivée.
--
-- L'ancien gabarit SUBSCRIPTION_EXPIRING n'est ni modifié ni supprimé (il n'est
-- déclenché par aucun code).
-- Idempotente. Retour arrière : l'ancien code n'écrit jamais ce type et clôt
-- sans envoi (cancelled) une demande restée en file ; tables ignorées.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE transactional_email_jobs DROP CONSTRAINT IF EXISTS transactional_email_jobs_kind_check;
ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check
  CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER'));

INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
SELECT 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER',
       $l68c_subject$Votre abonnement annuel Verebona sera renouvelé le {{renewalDate}}$l68c_subject$,
       $l68c_body$Bonjour {{firstName}},

Votre abonnement annuel {{planLabel}} sera renouvelé automatiquement le {{renewalDate}}, {{renewalDelayLabel}}.

Le renouvellement automatique est activé par défaut. Sans action de votre part, votre abonnement sera reconduit pour une nouvelle année.

Montant prévu pour ce renouvellement : {{amountLabel}}.

Si vous ne souhaitez pas renouveler votre abonnement, vous pouvez désactiver son renouvellement automatique avant cette date depuis votre espace de gestion Stripe.

Gérer mon abonnement sur Stripe : {{manageSubscriptionUrl}}

Vous pouvez également y consulter vos informations de facturation et vos moyens de paiement.

L’équipe Verebona$l68c_body$,
       '["firstName","planLabel","renewalDate","renewalDelayLabel","amountLabel","manageSubscriptionUrl"]',
       now()
 WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER');

CREATE TABLE IF NOT EXISTS annual_renewal_reminder_state (
  id integer PRIMARY KEY DEFAULT 1,
  coverage_from date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT annual_renewal_reminder_state_singleton_check CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS annual_renewal_reminder_checks (
  candidate_key text PRIMARY KEY,
  account_id integer NOT NULL,
  stripe_subscription_id text NOT NULL,
  renewal_date date NOT NULL,
  checked_on date NOT NULL,
  outcome text NOT NULL,
  reason text,
  job_id integer,
  checks integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT annual_renewal_reminder_checks_outcome_check
    CHECK (outcome IN ('ENQUEUED', 'REVIVED', 'DUPLICATE', 'WAITING', 'EXCLUDED', 'NO_RECIPIENT'))
);

INSERT INTO scheduled_task_state (code, admin_disabled, admin_disabled_at, last_note, created_at, updated_at)
VALUES ('subscription-annual-renewal-reminders', true, now(),
        'Créée suspendue (lot 68C) : à réactiver au moment de la bascule des rappels Stripe vers Verebona.', now(), now())
ON CONFLICT (code) DO NOTHING;
