-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1125 : compteurs AGRÉGÉS des refus d'adresses e-mail jetables
-- (lot 109F, ticket « E-mails jetables »). Service :
-- `src/services/auth/disposable-email-guard.ts`.
--
--   disposable_email_refusals — une ligne par (jour, voie, domaine de liste,
--       motif, version du référentiel) avec le nombre de refus. JAMAIS
--       d'adresse complète, d'utilisateur ni d'adresse IP : seulement l'entrée
--       de liste qui a décidé (ex. « yopmail.com »). Sert au suivi (volume par
--       voie, effet d'une mise à jour de liste, repérage d'un faux positif).
--       Purge bornée à l'écriture (365 jours, DISPOSABLE_REFUSAL_RETENTION_DAYS).
--
-- Table transversale sans account_id (aucune donnée de compte) : rien à
-- brancher sur la suppression de compte. Additive, idempotente, rejouable.
-- Retour arrière : DROP TABLE IF EXISTS disposable_email_refusals (le code
-- tolère son absence : la métrique n'est alors pas enregistrée).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS disposable_email_refusals (
  day           DATE        NOT NULL,
  channel       TEXT        NOT NULL,
  domain        TEXT        NOT NULL,
  reason        TEXT        NOT NULL,
  list_version  TEXT        NOT NULL,
  refusals      INTEGER     NOT NULL DEFAULT 1,
  first_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT disposable_email_refusals_pk PRIMARY KEY (day, channel, domain, reason, list_version),
  CONSTRAINT disposable_email_refusals_domain_check CHECK (char_length(domain) BETWEEN 1 AND 253 AND position('@' in domain) = 0),
  CONSTRAINT disposable_email_refusals_channel_check CHECK (char_length(channel) BETWEEN 1 AND 40),
  CONSTRAINT disposable_email_refusals_reason_check CHECK (char_length(reason) BETWEEN 1 AND 40),
  CONSTRAINT disposable_email_refusals_version_check CHECK (char_length(list_version) BETWEEN 1 AND 80)
);

COMMENT ON TABLE disposable_email_refusals IS
  'Lot 109F : refus d''adresses e-mail jetables, compteurs agrégés par jour / voie / domaine de liste / motif / version — jamais d''adresse complète.';
