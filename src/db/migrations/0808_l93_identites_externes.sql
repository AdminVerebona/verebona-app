-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0808 : connexion Google / Apple (lot 93, CDC 18 sous-lot B —
-- §5, §7.2, §8, §12, §31.1, §31.2, §31.5).
--
-- 1. `users.password_hash` devient FACULTATIF (CDC 18 §31.1, SEC-01) : un
--    compte créé avec Google ou Apple peut n'avoir aucun mot de passe
--    (« social-only »). Les comptes existants gardent leur empreinte : rien
--    n'est réécrit. Relâcher NOT NULL ne touche aucune ligne (métadonnée
--    seulement) ; rejouable sans effet.
--
-- 2. `auth_identities` (CDC 18 §31.2) : lien entre un utilisateur et
--    l'identifiant STABLE d'un fournisseur (issuer + subject). UNIQUE(provider,
--    issuer, subject) : une identité externe n'appartient qu'à un seul
--    utilisateur (SEC-02, §8.3). UNIQUE(user_id, provider) : un seul Google et
--    un seul Apple par utilisateur (Mon compte › Sécurité « Connecté /
--    Connecter », §27.1). L'adresse fournie est INFORMATIVE (jamais une clé de
--    rattachement, §5). `refresh_token_ciphertext` : jeton de renouvellement
--    Apple CHIFFRÉ (AES-256-GCM), conservé uniquement pour la révocation
--    imposée par Apple à la suppression du compte (§25) ; jamais exporté.
--    Supprimée avec l'utilisateur (ON DELETE CASCADE).
--
-- 3. `auth_transactions` (CDC 18 §31.5, §12.2, §19.2) : transaction OAuth
--    serveur à usage unique et courte (10 min) — state et liaison au
--    navigateur stockés HACHÉS, nonce haché, vérificateur PKCE, contexte
--    d'inscription (invitation, transmission, parrainage, retour interne),
--    puis, après le retour du fournisseur, l'étape d'inscription en attente
--    (choix « J'ai déjà un compte » / « Créer un nouveau compte », profil,
--    code de vérification d'adresse haché). Purgée par la tâche interne
--    `auth-transactions-purge`. Jamais exportée (secrets).
--
-- Additive et idempotente. Tables neuves : index créés ici (instantané).
-- Retour arrière : DROP TABLE IF EXISTS auth_transactions, auth_identities
-- (les comptes sans mot de passe ne pourraient alors plus se connecter).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS auth_identities (
  id                        BIGSERIAL   PRIMARY KEY,
  user_id                   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                  TEXT        NOT NULL CHECK (provider IN ('google', 'apple')),
  issuer                    TEXT        NOT NULL,
  subject                   TEXT        NOT NULL,
  email_at_link_time        TEXT,
  email_verified            BOOLEAN,
  last_provider_email       TEXT,
  is_private_relay          BOOLEAN     NOT NULL DEFAULT false,
  refresh_token_ciphertext  TEXT,
  linked_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_subject_uq
  ON auth_identities (provider, issuer, subject);
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_user_provider_uq
  ON auth_identities (user_id, provider);

CREATE TABLE IF NOT EXISTS auth_transactions (
  id                     BIGSERIAL   PRIMARY KEY,
  provider               TEXT        NOT NULL CHECK (provider IN ('google', 'apple')),
  intent                 TEXT        NOT NULL CHECK (intent IN ('login', 'signup', 'link', 'reauth')),
  status                 TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'received', 'awaiting_user', 'handoff', 'consumed', 'failed')),
  state_hash             TEXT        NOT NULL,
  binding_hash           TEXT        NOT NULL,
  nonce_hash             TEXT        NOT NULL,
  code_verifier          TEXT        NOT NULL,
  user_id                INTEGER     REFERENCES users(id) ON DELETE CASCADE,
  session_sid            TEXT,
  context                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  claims                 JSONB,
  stage                  TEXT,
  pending_email          TEXT,
  email_code_hash        TEXT,
  email_code_expires_at  TIMESTAMPTZ,
  email_code_attempts    INTEGER     NOT NULL DEFAULT 0,
  email_code_sent_at     TIMESTAMPTZ,
  handoff_hash           TEXT,
  failure_code           TEXT,
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_transactions_state_uq ON auth_transactions (state_hash);
CREATE UNIQUE INDEX IF NOT EXISTS auth_transactions_handoff_uq ON auth_transactions (handoff_hash) WHERE handoff_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_transactions_binding_idx ON auth_transactions (binding_hash);
CREATE INDEX IF NOT EXISTS auth_transactions_expires_idx ON auth_transactions (expires_at);
CREATE INDEX IF NOT EXISTS auth_transactions_user_idx ON auth_transactions (user_id) WHERE user_id IS NOT NULL;
