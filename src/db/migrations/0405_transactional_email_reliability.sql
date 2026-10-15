-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0405 : e-mails indispensables fiabilisés (lot 57A, ticket P0
-- « Corriger les échecs d'e-mails bloquant l'inscription, la vérification des
-- comptes et les invitations Duo »).
--
--   1. email_logs — état de LIVRAISON distinct du statut d'envoi.
--      `status` garde EXACTEMENT son sens (sent = accepté par Resend, failed,
--      skipped, pending) : les compteurs du BO (Communications, santé des
--      notifications, historique utilisateur) restent justes. S'ajoutent :
--        · provider_message_id  identifiant du message chez Resend ;
--        · delivery_status      accepted | delivery_delayed | delivered |
--                               complained | bounced | failed | suppressed
--                               (mis à jour par les webhooks Resend) ;
--        · delivery_status_at, delivered_at, delivery_error ;
--        · triggered_by_user_id utilisateur À L'ORIGINE de l'envoi (titulaire
--                               Duo), distinct du destinataire
--                               (recipient_user_id) ;
--        · email_job_id         tentative d'un envoi durable (ci-dessous).
--
--   2. transactional_email_jobs — file DURABLE des e-mails sans lesquels le
--      parcours est bloqué (EMAIL_VERIFICATION, DUO_INVITATION). La demande
--      est enregistrée en base AVANT toute tentative ; la tâche planifiée
--      interne `transactional-emails-retry` reprend les demandes non abouties
--      (processus arrêté, fournisseur indisponible), au plus `max_attempts`
--      fois. AUCUN jeton n'y est stocké : le lien est reconstruit à chaque
--      tentative (lien de vérification signé neuf, jeton Duo relu).
--
--   3. email_provider_events — événements webhook Resend reçus (signature
--      Svix vérifiée par la route) : `event_id` (svix-id) unique → rejeu sans
--      effet ; appliqués quel que soit l'ordre d'arrivée.
--
--   5. Gabarit EMAIL_VERIFICATION créé s'il manque (voir en fin de fichier).
--
--   4. duo_accounts.last_used_invite_token_hash — empreinte SHA-256 du
--      dernier jeton d'invitation consommé : « invitation déjà utilisée » est
--      distinguée d'un lien inconnu (inscription des invités, P2). Le jeton
--      lui-même n'est jamais conservé.
--
-- Idempotente (IF NOT EXISTS). Index en fichiers `_idx_N` (CONCURRENTLY).
-- Retour arrière : colonnes et tables nouvelles, ignorées par l'ancien code.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS delivery_status text;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS delivery_status_at timestamptz;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS delivery_error text;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS triggered_by_user_id integer;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS email_job_id integer;

CREATE TABLE IF NOT EXISTS transactional_email_jobs (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  duo_id integer REFERENCES duo_accounts(id) ON DELETE CASCADE,
  triggered_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  last_email_log_id integer,
  provider_message_id text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactional_email_jobs_kind_check CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION')),
  CONSTRAINT transactional_email_jobs_status_check CHECK (status IN ('pending', 'sending', 'accepted', 'failed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS email_provider_events (
  id serial PRIMARY KEY,
  provider text NOT NULL DEFAULT 'resend',
  event_id text NOT NULL,
  event_type text NOT NULL,
  provider_message_id text,
  occurred_at timestamptz,
  detail text,
  applied_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_provider_events_event_unique UNIQUE (provider, event_id)
);

ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS last_used_invite_token_hash text;

-- 5. Gabarit EMAIL_VERIFICATION garanti. Il n'était créé que par l'amorçage
--    manuel (`/api/cron/seed?only=email-system`) : une base sans amorçage
--    refusait TOUS les e-mails de vérification (« Template EMAIL_VERIFICATION
--    not found ») — aucun compte ne pouvait être activé. Créé seulement s'il
--    manque (casse ignorée, comme la recherche du service) : un gabarit
--    retouché dans le BO n'est jamais écrasé.
INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
SELECT 'EMAIL_VERIFICATION',
       'Vérifiez votre adresse e-mail - Verebona',
       E'Bonjour {{firstName}},\n\nMerci de vous être inscrit sur Verebona. Pour activer votre compte, confirmez votre adresse e-mail :\n\nActiver mon compte : {{verificationUrl}}\n\nCe lien est valable 24 heures et ne peut servir qu''une fois. Si vous n''êtes pas à l''origine de cette inscription, ignorez ce message.\n\nCordialement,\nL''équipe Verebona',
       '["firstName","verificationUrl"]',
       now()
 WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'EMAIL_VERIFICATION');
