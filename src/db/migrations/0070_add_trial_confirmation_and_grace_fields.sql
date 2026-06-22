ALTER TABLE accounts ADD COLUMN trial_confirmation_email_sent_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN trial_ends_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN past_due_grace_started_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN past_due_grace_ends_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN checkout_session_id TEXT;
ALTER TABLE accounts ADD COLUMN checkout_session_created_at TIMESTAMPTZ;
