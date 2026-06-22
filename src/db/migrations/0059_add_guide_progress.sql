-- Guide "Bien démarrer" — V1
-- Adds guide_auto_open_disabled to users and creates user_guide_progress table

ALTER TABLE users ADD COLUMN IF NOT EXISTS guide_auto_open_disabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS user_guide_progress (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'skipped')),
  completed_at TIMESTAMPTZ,
  skipped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_guide_progress_user_step_unique UNIQUE (user_id, step_key)
);

CREATE INDEX IF NOT EXISTS user_guide_progress_user_id_idx ON user_guide_progress(user_id);
