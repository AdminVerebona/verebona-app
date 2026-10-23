-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0632 : suivi des générations d'export du back-office (lot 81C).
--
--   admin_export_generations — une ligne par génération d'export intégral
--   (« Données du compte » : JSON / CSV / TXT ; diagnostics techniques :
--   ZIP ou consultation) : périmètre et filtres, statut RUNNING → COMPLETE /
--   PARTIAL / FAILED, instant de référence et instantané PostgreSQL de la
--   lecture, lignes attendues / exportées, lots, octets, bilan PAR SECTION
--   (`sections` : attendu, exporté, lots, statut, erreur, horodatage) et
--   erreur technique exploitable. Affiché au BO (Diagnostics techniques ›
--   « Générations d'export ») ; une interruption n'est jamais présentée
--   comme complète.
--
-- Journal technique d'administration, comme `admin_audit_log` : la cible
-- est désignée par `target_type` / `target_id` / `target_account_id` (pas de
-- colonne `account_id` : la table n'appartient à aucun compte et n'entre
-- dans aucun classement de données de compte ou de bien). Aucun contenu
-- exporté n'est conservé ici.
--
-- Idempotente : rejouable sans effet.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_export_generations (
  id                 UUID        PRIMARY KEY,
  kind               TEXT        NOT NULL,
  mode               TEXT        NOT NULL,
  admin_user_id      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  target_type        TEXT,
  target_id          BIGINT,
  target_account_id  INTEGER,
  perimeter          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT        NOT NULL DEFAULT 'RUNNING',
  snapshot_at        TIMESTAMPTZ,
  pg_snapshot        TEXT,
  rows_expected      BIGINT,
  rows_exported      BIGINT,
  batches            INTEGER,
  bytes              BIGINT,
  files              INTEGER,
  sections           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  error              TEXT,
  file_name          TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  CONSTRAINT admin_export_generations_kind_chk CHECK (kind IN ('ACCOUNT_DATA', 'TECH_DIAGNOSTIC')),
  CONSTRAINT admin_export_generations_status_chk CHECK (status IN ('RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS admin_export_generations_started_idx ON admin_export_generations (started_at DESC, id);
CREATE INDEX IF NOT EXISTS admin_export_generations_target_idx ON admin_export_generations (target_account_id, started_at DESC);
