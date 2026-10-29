-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0814 : socle serveur de l'application mobile — registre des
-- installations push natives (lot 97, CDC 12 « Application mobile iOS &
-- Android V1 » §18.1, PUSH-01..12, Annexe A).
--
-- `mobile_push_installations` : une ligne par INSTALLATION de l'application
-- (identifiant applicatif généré par l'app à l'installation, en-tête
-- `X-Verebona-Installation-Id`). Rattachée à un UTILISATEUR (jamais au compte
-- Duo, DUO-05) ; compte actif au moment de l'enregistrement à titre
-- d'information. Jeton push (FCM, APNs via FCM) CHIFFRÉ au repos
-- (`push_token_enc`, AES-256-GCM) + empreinte SHA-256 (`push_token_hash`,
-- recherche d'un même jeton sur une autre installation) : jamais exporté
-- (diagnostic : colonnes exclues ; export RGPD : motif « token »).
-- `session_id` : famille de session (`sid`) qui a enregistré l'appareil —
-- la révocation de cette session désactive le push de l'appareil (AUTH-10,
-- PUSH-08 : `deactivatePushForSession`).
--
-- Statuts (Annexe A) : active | logged_out | invalid_token | revoked.
-- Une installation non active n'a plus de jeton (colonnes vidées).
--
-- `notification_deliveries.mobile_push_installation_id` : une livraison push
-- par appareil mobile (même journal que le Web Push, canal `push`).
--
-- Additive, idempotente, aucune reprise de données. Suppression : avec
-- l'utilisateur (ON DELETE CASCADE) ; compte supprimé → `account_id` NULL
-- (l'appareil reste celui de l'utilisateur). Table neuve : index créés ici.
-- Retour arrière : DROP TABLE IF EXISTS mobile_push_installations CASCADE
-- (la colonne de livraison perd sa contrainte, le Web Push n'est pas touché).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS mobile_push_installations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id  TEXT        NOT NULL,
  user_id          INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id       INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
  platform         TEXT        NOT NULL,
  app_version      TEXT,
  build_number     TEXT,
  push_provider    TEXT        NOT NULL DEFAULT 'fcm',
  push_token_enc   TEXT,
  push_token_hash  TEXT,
  environment      TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'active',
  status_reason    TEXT,
  session_id       TEXT,
  failure_count    INTEGER     NOT NULL DEFAULT 0,
  last_error_code  TEXT,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at  TIMESTAMPTZ,
  last_failure_at  TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mobile_push_installations_installation_unique UNIQUE (installation_id),
  CONSTRAINT mobile_push_installations_platform_check CHECK (platform IN ('ios', 'android')),
  CONSTRAINT mobile_push_installations_status_check CHECK (status IN ('active', 'logged_out', 'invalid_token', 'revoked')),
  CONSTRAINT mobile_push_installations_environment_check CHECK (environment IN ('local', 'preprod', 'production'))
);

CREATE INDEX IF NOT EXISTS mobile_push_installations_user_status_idx ON mobile_push_installations (user_id, status);
CREATE INDEX IF NOT EXISTS mobile_push_installations_token_hash_idx ON mobile_push_installations (push_token_hash) WHERE push_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS mobile_push_installations_session_idx ON mobile_push_installations (session_id) WHERE session_id IS NOT NULL;

ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS mobile_push_installation_id UUID
    REFERENCES mobile_push_installations(id) ON DELETE SET NULL;
