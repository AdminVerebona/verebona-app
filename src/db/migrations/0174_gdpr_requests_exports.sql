-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0174 — RGPD : registre des demandes et export « Mes données ».
--
-- CDC Back-Office V1 §12 (GDP-001 à GDP-023), audit BO §2.11.
--
--   1. `gdpr_requests` — suivi opérationnel des demandes relatives aux droits
--      des personnes. Deux origines :
--        • system : générée par l'application (suppression de compte engagée
--          par l'utilisateur, export « Mes données »). Statut piloté par le
--          système, jamais modifiable depuis le BO (GDP-007, GDP-008).
--        • manual : saisie par le support pour une demande reçue hors
--          application (GDP-010 à GDP-017).
--      L'échéance (`due_date`) est TOUJOURS calculée côté serveur
--      (réception + 1 mois, GDP-011) ; aucune route ne l'accepte en entrée.
--
--      Survie à la suppression du compte : `user_id` / `account_id` passent à
--      NULL par la cascade (ON DELETE SET NULL) ; `subject_user_ref` /
--      `subject_account_ref` (sans clé étrangère) gardent la référence pour la
--      preuve du traitement. L'e-mail et le nom de compte figés sont effacés
--      à l'exécution de la suppression (pseudonymisation).
--
--   2. `gdpr_exports` — génération asynchrone de l'archive « Mes données »
--      (GDP-020 à GDP-022) : état, clé S3, taille, erreur, expiration.
--      Supprimée avec l'utilisateur (CASCADE) ; l'objet S3 est mis en file de
--      purge par le workflow de suppression.
--
--   3. Modèle d'e-mail `notif_gdpr_export` de la notification « export prêt ».
--
-- Idempotente : peut être rejouée sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Registre des demandes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gdpr_requests (
  id                   SERIAL PRIMARY KEY,
  origin               TEXT        NOT NULL,
  user_id              INTEGER     REFERENCES users(id)    ON DELETE SET NULL,
  account_id           INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
  subject_user_ref     INTEGER,
  subject_account_ref  INTEGER,
  subject_email        TEXT,
  subject_account_name TEXT,
  right_type           TEXT        NOT NULL,
  channel              TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'received',
  received_at          TIMESTAMPTZ NOT NULL,
  due_date             DATE        NOT NULL,
  processed_at         TIMESTAMPTZ,
  internal_comment     TEXT,
  result               TEXT,
  last_error           TEXT,
  reopened_at          TIMESTAMPTZ,
  reopened_by          INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  reopen_count         INTEGER     NOT NULL DEFAULT 0,
  created_by           INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_by           INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  -- Clé d'idempotence : `scheduled_deletion:<id>`, `gdpr_export:<id>`,
  -- `self_deletion:<userId>`, `manual:<Idempotency-Key>` (ERR-002).
  source_ref           TEXT        UNIQUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gdpr_requests_origin_check  CHECK (origin IN ('system', 'manual')),
  CONSTRAINT gdpr_requests_status_check  CHECK (status IN ('received', 'in_progress', 'done')),
  CONSTRAINT gdpr_requests_right_check   CHECK (right_type IN (
    'access', 'rectification', 'erasure', 'restriction', 'portability', 'objection', 'other'
  )),
  CONSTRAINT gdpr_requests_channel_check CHECK (channel IN ('app', 'email', 'postal_mail', 'phone', 'other')),
  -- Une demande traitée porte sa date de traitement ; une demande ouverte n'en a pas.
  CONSTRAINT gdpr_requests_processed_check CHECK ((status = 'done') = (processed_at IS NOT NULL)),
  -- Une demande système est rattachée à son fait générateur.
  CONSTRAINT gdpr_requests_system_ref_check CHECK (origin = 'manual' OR source_ref IS NOT NULL)
);

-- Vue par défaut (GDP-001, GDP-005) : demandes ouvertes triées par échéance.
CREATE INDEX IF NOT EXISTS gdpr_requests_open_due_idx
  ON gdpr_requests (due_date) WHERE status <> 'done';
-- Historique et compteur « traitées sur la période » (GDP-002, GDP-018).
CREATE INDEX IF NOT EXISTS gdpr_requests_processed_idx
  ON gdpr_requests (processed_at) WHERE status = 'done';
CREATE INDEX IF NOT EXISTS gdpr_requests_user_idx    ON gdpr_requests (user_id);
CREATE INDEX IF NOT EXISTS gdpr_requests_account_idx ON gdpr_requests (account_id);

-- 2. Exports « Mes données » ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gdpr_exports (
  id              SERIAL PRIMARY KEY,
  request_id      INTEGER     REFERENCES gdpr_requests(id) ON DELETE SET NULL,
  user_id         INTEGER     NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  account_id      INTEGER     REFERENCES accounts(id)          ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'pending',
  s3_key          TEXT,
  size_bytes      BIGINT,
  summary         JSONB,
  error_message   TEXT,
  attempt_count   INTEGER     NOT NULL DEFAULT 0,
  -- Réponse asynchrone faite à l'utilisateur : notifier quand l'archive est prête.
  notify_on_ready BOOLEAN     NOT NULL DEFAULT false,
  notified_at     TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gdpr_exports_status_check
    CHECK (status IN ('pending', 'generating', 'ready', 'error', 'expired'))
);

CREATE INDEX IF NOT EXISTS gdpr_exports_user_idx ON gdpr_exports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gdpr_exports_expiry_idx ON gdpr_exports (expires_at) WHERE status = 'ready';
-- Une seule génération en cours par utilisateur (double clic, ERR-002).
CREATE UNIQUE INDEX IF NOT EXISTS gdpr_exports_one_active_idx
  ON gdpr_exports (user_id) WHERE status IN ('pending', 'generating');

-- 3. Modèle d'e-mail de la notification « export prêt » ─────────────────────
INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('notif_gdpr_export', 'Votre export de données est prêt',
   E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
