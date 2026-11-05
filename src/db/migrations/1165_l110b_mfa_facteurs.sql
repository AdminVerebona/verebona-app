-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1165 : double authentification — facteurs et contextes (lot 110B,
-- ticket MFA §2, §4, §5, §6). Tables NOUVELLES, additive, idempotente.
--
--   user_mfa_state     : un compte protégé (`enabled_at`, posé au PREMIER
--                        facteur, jamais remis à NULL par un réglage — un
--                        retour arrière de l'obligation ne désactive pas la
--                        MFA d'un compte protégé) ; conservation des codes
--                        confirmée ; dernière méthode employée (affichage).
--   mfa_passkeys       : clés d'accès WebAuthn — identifiant de credential
--                        (unique), clé PUBLIQUE (COSE, base64url), compteur,
--                        transports, type, sauvegarde, nom, dernière
--                        utilisation. Jamais de clé privée ni de biométrie.
--   mfa_totp_factors   : application d'authentification — secret CHIFFRÉ
--                        (AES-256-GCM, clé hors base, `key_id` pour la
--                        rotation), PENDING jusqu'au premier code vérifié,
--                        une seule ACTIVE par compte, dernier intervalle
--                        utilisé (anti-rejeu).
--   mfa_recovery_codes : EMPREINTES (SHA-256) des 10 codes, usage unique.
--   mfa_challenges     : défis WebAuthn et codes e-mail de récupération —
--                        usage unique, courts, liés à une opération et à un
--                        contexte (empreinte).
--   mfa_pending_auth   : contexte d'authentification PROVISOIRE (10 min,
--                        usage unique) entre la preuve primaire et la preuve
--                        forte ; n'ouvre aucune session métier.
--
-- Suppression du compte : ON DELETE CASCADE vers `users` — secrets, clés
-- publiques, empreintes et contextes disparaissent avec l'utilisateur (cycle
-- de vie existant, contrôle des orphelins). Aucune donnée existante modifiée.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_mfa_state (
  user_id               INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled_at            TIMESTAMPTZ,
  recovery_confirmed_at TIMESTAMPTZ,
  last_method           TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfa_passkeys (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT        NOT NULL,
  public_key    TEXT        NOT NULL,
  counter       BIGINT      NOT NULL DEFAULT 0,
  transports    TEXT[]      NOT NULL DEFAULT '{}',
  device_type   TEXT,
  backed_up     BOOLEAN     NOT NULL DEFAULT false,
  aaguid        TEXT,
  name          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS mfa_passkeys_credential_uq ON mfa_passkeys (credential_id);
CREATE INDEX IF NOT EXISTS mfa_passkeys_user_idx ON mfa_passkeys (user_id);

CREATE TABLE IF NOT EXISTS mfa_totp_factors (
  id                 BIGSERIAL   PRIMARY KEY,
  user_id            INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             TEXT        NOT NULL,
  secret_ciphertext  TEXT        NOT NULL,
  key_id             TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  pending_expires_at TIMESTAMPTZ,
  confirmed_at       TIMESTAMPTZ,
  last_used_step     BIGINT,
  last_used_at       TIMESTAMPTZ,
  CONSTRAINT mfa_totp_factors_status_chk CHECK (status IN ('PENDING', 'ACTIVE'))
);
-- Une seule application ACTIVE et un seul secret EN ATTENTE par compte.
CREATE UNIQUE INDEX IF NOT EXISTS mfa_totp_factors_active_uq ON mfa_totp_factors (user_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS mfa_totp_factors_pending_uq ON mfa_totp_factors (user_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS mfa_recovery_codes_user_hash_uq ON mfa_recovery_codes (user_id, code_hash);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id           TEXT        PRIMARY KEY,
  user_id      INTEGER     REFERENCES users(id) ON DELETE CASCADE,
  purpose      TEXT        NOT NULL,
  challenge    TEXT        NOT NULL,
  binding_hash TEXT        NOT NULL,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  CONSTRAINT mfa_challenges_purpose_chk CHECK (purpose IN ('passkey_register', 'passkey_login', 'passkey_stepup', 'recovery_email'))
);
CREATE INDEX IF NOT EXISTS mfa_challenges_user_idx ON mfa_challenges (user_id, purpose);
CREATE INDEX IF NOT EXISTS mfa_challenges_expires_idx ON mfa_challenges (expires_at);

CREATE TABLE IF NOT EXISTS mfa_pending_auth (
  id                 TEXT        PRIMARY KEY,
  user_id            INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose            TEXT        NOT NULL,
  primary_method     TEXT        NOT NULL,
  return_url         TEXT,
  remember_device    BOOLEAN     NOT NULL DEFAULT true,
  factor_enrolled_at TIMESTAMPTZ,
  enrolled_factor    TEXT,
  recovered_at       TIMESTAMPTZ,
  cancelled          BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  completed_at       TIMESTAMPTZ,
  CONSTRAINT mfa_pending_auth_purpose_chk CHECK (purpose IN ('challenge', 'enroll'))
);
CREATE INDEX IF NOT EXISTS mfa_pending_auth_user_idx ON mfa_pending_auth (user_id);
CREATE INDEX IF NOT EXISTS mfa_pending_auth_expires_idx ON mfa_pending_auth (expires_at);
