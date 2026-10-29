-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0829 : demandes de changement de l'adresse e-mail principale
-- (lot 96A, CDC 18 §11.3, EMAIL-03..07 ; décision PO Q8).
--
-- Une demande naît APRÈS une réauthentification fraîche (preuve 92) ; elle
-- porte la nouvelle adresse et l'EMPREINTE (SHA-256) du lien envoyé à cette
-- adresse — jamais le lien en clair. L'ancienne adresse reste principale
-- tant que le lien n'est pas validé. Lien à usage unique (`consumed_at`),
-- délai propre (`expires_at`, 24 h), une seule demande ouverte par
-- utilisateur (une nouvelle demande annule la précédente : `cancelled_at`).
--
-- Supprimée avec l'utilisateur (ON DELETE CASCADE). Jamais exportée
-- (empreinte de lien) ; une restauration ne la ressuscite pas.
-- Purge : demandes terminées depuis plus de 30 jours (tâche interne
-- `auth-rate-limits-purge`).
--
-- Additive et idempotente. Table neuve : index créés ici (instantané).
-- Retour arrière : DROP TABLE IF EXISTS email_change_requests.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS email_change_requests (
  id              BIGSERIAL   PRIMARY KEY,
  user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_email       TEXT        NOT NULL,
  new_email       TEXT        NOT NULL,
  token_hash      TEXT        NOT NULL,
  requested_sid   TEXT,
  reauth_method   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS email_change_requests_token_uq ON email_change_requests (token_hash);
CREATE INDEX IF NOT EXISTS email_change_requests_user_idx ON email_change_requests (user_id, created_at DESC);
