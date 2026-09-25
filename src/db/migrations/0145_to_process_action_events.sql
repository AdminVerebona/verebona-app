-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0145 — Trace technique des décisions « À traiter » (CDC V2 §13.5)
--
-- « Une résolution directe d'arbitrage doit être atomique : appliquer la
-- valeur, marquer la validation utilisateur, résoudre l'action et enregistrer
-- la trace technique dans la même transaction logique. » La trace n'existait
-- pas : cette table la porte, écrite dans la même transaction que la
-- résolution. Elle sert aussi aux décisions « Non applicable » et aux
-- fermetures pour changement de nature (OBSOLETE).
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS to_process_action_events (
  id             SERIAL      PRIMARY KEY,
  action_id      INTEGER     REFERENCES to_process_actions(id) ON DELETE CASCADE,
  account_id     INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- RESOLVED_ARBITRATION | NOT_APPLICABLE | OBSOLETE | SKIPPED_NOT_APPLICABLE…
  event          TEXT        NOT NULL,
  actor_user_id  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  target_type    TEXT,
  target_id      INTEGER,
  field_key      TEXT,
  previous_value JSONB,
  new_value      JSONB,
  details        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS to_process_action_events_action_idx ON to_process_action_events (action_id);
CREATE INDEX IF NOT EXISTS to_process_action_events_account_idx ON to_process_action_events (account_id, created_at);
