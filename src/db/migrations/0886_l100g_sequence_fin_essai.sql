-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0886 : séquence d'e-mails de fin d'essai (lot 100G ; décision PO
-- « Questions PO (3) », sections E, E1, E2, F, du 27/10/2026).
--
--   1. trial_lifecycle_settings : réglages du BO (une ligne) — notifications de
--      service J−2 / J0, campagne commerciale J+3 → J+60 (DÉSACTIVÉE par
--      défaut), base légale, fenêtres de rattrapage, heures d'envoi, lien
--      « offres ». Valeur vide = réglages par défaut du code (prudents).
--   2. trial_lifecycle_messages : UN message par compte × fin d'essai × jalon
--      (clé unique = aucun doublon, idempotence de la tâche planifiée) ; état,
--      motif de non-envoi, modèle et version, journal d'e-mail, tentatives.
--   3. trial_lifecycle_events : journal AUDITABLE, en ajout seul — envoi,
--      échec, non-envoi motivé, blocage, conversion, désinscription,
--      changement de réglage. Une conversion par compte × essai (index unique).
--   4. marketing_oppositions : opposition aux communications commerciales
--      (lien « Ne plus recevoir… », sans connexion). Jamais levée seule.
--
-- Tables avec user_id / account_id : clés étrangères EN CASCADE (suppression
-- du compte ou de l'utilisateur), collectées par l'export RGPD (schéma).
-- Idempotente (IF NOT EXISTS). Retour arrière : l'ancien code les ignore.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS trial_lifecycle_settings (
  id smallint PRIMARY KEY DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_email text,
  CONSTRAINT trial_lifecycle_settings_single_row CHECK (id = 1),
  CONSTRAINT trial_lifecycle_settings_object CHECK (jsonb_typeof(settings) = 'object')
);

CREATE TABLE IF NOT EXISTS trial_lifecycle_messages (
  id bigserial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  trial_ends_at timestamptz NOT NULL,
  milestone text NOT NULL,
  nature text NOT NULL,
  template_code text NOT NULL,
  template_version integer,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  legal_basis text,
  attempt_count integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  claimed_at timestamptz,
  decided_at timestamptz,
  sent_at timestamptz,
  email_log_id integer,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_lifecycle_messages_key UNIQUE (account_id, trial_ends_at, milestone),
  CONSTRAINT trial_lifecycle_messages_milestone_check CHECK (milestone IN ('J_MINUS_2', 'J0', 'J3', 'J10', 'J30', 'J60', 'J80')),
  CONSTRAINT trial_lifecycle_messages_nature_check CHECK (nature IN ('service', 'commercial', 'conditional')),
  CONSTRAINT trial_lifecycle_messages_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'deferred', 'blocked', 'skipped'))
);

CREATE TABLE IF NOT EXISTS trial_lifecycle_events (
  id bigserial PRIMARY KEY,
  account_id integer REFERENCES accounts(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint REFERENCES trial_lifecycle_messages(id) ON DELETE CASCADE,
  trial_ends_at timestamptz,
  milestone text,
  event_type text NOT NULL,
  template_code text,
  template_version integer,
  reason text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_lifecycle_events_type_check CHECK (event_type IN ('sent', 'failed', 'not_sent', 'deferred', 'blocked', 'conversion', 'unsubscribe', 'settings_changed')),
  CONSTRAINT trial_lifecycle_events_actor_check CHECK (actor IN ('system', 'user', 'admin')),
  CONSTRAINT trial_lifecycle_events_detail_object CHECK (jsonb_typeof(detail) = 'object')
);

-- Une conversion attribuée par compte et par essai (passages rejoués sans doublon).
CREATE UNIQUE INDEX IF NOT EXISTS trial_lifecycle_events_conversion_uidx
  ON trial_lifecycle_events (account_id, trial_ends_at) WHERE event_type = 'conversion';

CREATE TABLE IF NOT EXISTS marketing_oppositions (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  opposed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  scope text NOT NULL DEFAULT 'commercial',
  CONSTRAINT marketing_oppositions_source_check CHECK (source IN ('email_link', 'one_click', 'admin', 'account')),
  CONSTRAINT marketing_oppositions_scope_check CHECK (scope IN ('commercial'))
);
