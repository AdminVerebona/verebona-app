-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0916 — lot 102C : copies de données réelles (production) dans un
-- autre environnement (préproduction).
--
-- Ticket conformité légale, P1 « Garantir suppression/expiration des copies
-- de production en préproduction ». Toute copie de données réelles hors
-- production est :
--   (a) TRACÉE : origine (point de restauration d'un autre environnement,
--       copie de base détectée), date, responsable, motif ;
--   (b) soumise à une EXPIRATION automatique (PRODUCTION_COPY_RETENTION_DAYS)
--       avec purge planifiée (comptes de la copie supprimés par le workflow
--       de suppression existant) ;
--   (c) VISIBLE en Supervision tant qu'elle existe.
-- L'import par restauration est REFUSÉ par défaut : il exige une
-- autorisation BO explicite, nominative et journalisée, pour un point donné.
--
--   1. environment_identity : une ligne, nom de l'environnement qui a
--      initialisé CETTE base. Une base chargée depuis la production (copie
--      hors application) porte « production » : détectée au démarrage.
--   2. production_data_copies : registre des copies (autorisées, actives,
--      purgées, closes).
--
-- Tables sans compte ni utilisateur rattachés (registre d'exploitation) :
-- elles survivent volontairement à la purge qu'elles décrivent (preuve).
-- Additive et idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS environment_identity (
  id smallint PRIMARY KEY DEFAULT 1,
  environment text NOT NULL,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  last_seen_environment text,
  last_seen_at timestamptz,
  CONSTRAINT environment_identity_single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS production_data_copies (
  id bigserial PRIMARY KEY,
  origin text NOT NULL,
  source_environment text NOT NULL,
  target_environment text NOT NULL,
  backup_id text,
  status text NOT NULL DEFAULT 'authorized',
  reason text NOT NULL,
  responsible_admin_id integer REFERENCES users(id) ON DELETE SET NULL,
  responsible_email text,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  imported_at timestamptz,
  expires_at timestamptz NOT NULL,
  account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  purge_started_at timestamptz,
  purged_at timestamptz,
  purge_report jsonb,
  closed_at timestamptz,
  closed_by_email text,
  close_reason text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_data_copies_origin_check CHECK (origin IN ('restore_point', 'database_copy')),
  CONSTRAINT production_data_copies_status_check CHECK (status IN ('authorized', 'active', 'purging', 'purged', 'closed', 'expired_unused')),
  CONSTRAINT production_data_copies_accounts_array CHECK (jsonb_typeof(account_ids) = 'array')
);

-- Une seule autorisation ouverte par point de restauration.
CREATE UNIQUE INDEX IF NOT EXISTS production_data_copies_backup_open_uidx
  ON production_data_copies (backup_id) WHERE status = 'authorized' AND backup_id IS NOT NULL;

COMMENT ON TABLE production_data_copies IS
  'Lot 102C : copies de données réelles hors production — tracées, expirées automatiquement, visibles en Supervision.';
COMMENT ON TABLE environment_identity IS
  'Lot 102C : environnement qui a initialisé cette base (détection d''une copie de base de production).';
