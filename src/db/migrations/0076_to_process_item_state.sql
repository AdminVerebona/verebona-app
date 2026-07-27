-- ============================================================================
-- 0076 — État persistant de la vue « À traiter » (CDC Notifications §7.3 / §12.6)
--
-- La page « À traiter » calcule une vue dynamique. Pour notifier un élément
-- UNE seule fois lorsqu'il devient réellement actif (et à nouveau s'il est
-- résolu puis réapparaît), on persiste son état ici. La clé de déduplication
-- immédiate inclut le cycle.
--
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS to_process_item_state (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,          -- ex. doc_123, agenda_456_missing_date, equip_7
  problem_key   TEXT,                   -- famille/motif stable (arbitrate|attach|confirm|complete)
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_since  TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  cycle_number  INTEGER NOT NULL DEFAULT 1,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT to_process_item_state_unique UNIQUE (account_id, item_key)
);

CREATE INDEX IF NOT EXISTS to_process_item_state_account_idx
  ON to_process_item_state (account_id);
CREATE INDEX IF NOT EXISTS to_process_item_state_active_idx
  ON to_process_item_state (account_id, is_active);

COMMENT ON TABLE to_process_item_state IS
  'État persistant de la vue « À traiter » pour détecter les entrées/sorties et notifier une fois par cycle actif (CDC §7.3).';
