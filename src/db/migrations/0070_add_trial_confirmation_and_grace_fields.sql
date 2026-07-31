-- `IF NOT EXISTS` sur chaque colonne : le schéma peut déjà les porter
-- lorsqu'il a été créé par `drizzle-kit push` depuis `schema.ts`.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trial_confirmation_email_sent_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS past_due_grace_started_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS past_due_grace_ends_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS checkout_session_id TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS checkout_session_created_at TIMESTAMPTZ;
