-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0970 — lot 104A (P1-F) : propagation des suppressions de
-- production vers les copies de données réelles en préproduction.
--
--   1. account_deletion_registry.signal_contacts : empreintes NON RÉVERSIBLES
--      (HMAC, clé PRODUCTION_DELETION_SIGNAL_KEY) des adresses des
--      utilisateurs supprimés, calculées par le moteur de purge au moment de
--      la suppression (l'adresse disparaît avec l'utilisateur). Vide si la
--      clé n'est pas configurée. Aucune adresse en clair.
--   2. production_data_copies.source_snapshot_at : instant de l'état source
--      copié (point de restauration) ; subjects_captured_at : inventaire des
--      comptes copiés établi.
--   3. production_copy_subjects : pour chaque copie, chaque compte et chaque
--      utilisateur COPIÉS (cible locale) avec les empreintes de leurs
--      identifiants SOURCE et de leur adresse au moment de l'import — la
--      correspondance source → cible est enregistrée, jamais présumée. Après
--      purge, les empreintes sont effacées (trace seule).
--   4. production_deletion_signal_state : dernier échange avec la production
--      (une ligne) — sert à juger la propagation « configurée et vérifiée ».
--
-- Tables d'exploitation sans compte rattaché (cibles = identifiants internes
-- sans clé étrangère) : elles survivent à la purge qu'elles décrivent.
-- Additive et idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE account_deletion_registry ADD COLUMN IF NOT EXISTS signal_contacts text[] NOT NULL DEFAULT '{}';

ALTER TABLE production_data_copies ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz;
ALTER TABLE production_data_copies ADD COLUMN IF NOT EXISTS subjects_captured_at timestamptz;

CREATE TABLE IF NOT EXISTS production_copy_subjects (
  id bigserial PRIMARY KEY,
  copy_id bigint NOT NULL REFERENCES production_data_copies(id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  target_id integer NOT NULL,
  id_fingerprints text[] NOT NULL DEFAULT '{}',
  contact_fingerprints text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'present',
  matched_at timestamptz,
  matched_signal_ref text,
  purged_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_copy_subjects_kind_check CHECK (subject_kind IN ('user', 'account')),
  CONSTRAINT production_copy_subjects_status_check CHECK (status IN ('present', 'failed', 'purged', 'closed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS production_copy_subjects_target_uidx
  ON production_copy_subjects (copy_id, subject_kind, target_id);
CREATE INDEX IF NOT EXISTS production_copy_subjects_open_idx
  ON production_copy_subjects (status) WHERE status IN ('present', 'failed');

CREATE TABLE IF NOT EXISTS production_deletion_signal_state (
  id smallint PRIMARY KEY DEFAULT 1,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status text NOT NULL DEFAULT 'never',
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  source_environment text,
  covers_since timestamptz,
  entries_seen integer NOT NULL DEFAULT 0,
  last_report jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_deletion_signal_state_single_row CHECK (id = 1)
);

COMMENT ON TABLE production_copy_subjects IS
  'Lot 104A : comptes et utilisateurs d''une copie de données réelles (cible locale + empreintes HMAC des identifiants source) — purge sur suppression en production.';
COMMENT ON TABLE production_deletion_signal_state IS
  'Lot 104A : dernier échange avec la production (propagation des suppressions vers les copies).';
COMMENT ON COLUMN account_deletion_registry.signal_contacts IS
  'Lot 104A : empreintes HMAC (non réversibles) des adresses des utilisateurs supprimés — propagation vers les copies en préproduction.';
