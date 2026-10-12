-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0326 : rattrapages ciblés du catalogue Stripe (lot 49A).
--
-- Une ligne par rattrapage automatique (clé fonctionnelle) et par contexte :
-- état, tentatives, prochaine tentative, dernière erreur, rapport. Exécuté
-- EXCLUSIVEMENT par la tâche interne `stripe-catalog-publish` ; affiché dans
-- le BO (Exploitation › Catalogue Stripe). Premier usage : reprise de la
-- publication préprod en échec « For each product, its price must have
-- unique billing intervals. » (contexte test:preprod uniquement).
--
-- ADDITIVE : table neuve, aucune donnée existante modifiée, aucun appel
-- Stripe. Table neuve vide : la contrainte d'unicité est instantanée (pas
-- d'index CONCURRENTLY nécessaire). Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS stripe_catalog_recoveries (
  id                 BIGSERIAL    PRIMARY KEY,
  catalog_context    TEXT         NOT NULL,
  recovery_key       TEXT         NOT NULL,
  status             TEXT         NOT NULL,
  run_id             BIGINT,
  attempts           INTEGER      NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_attempt_at    TIMESTAMPTZ,
  next_attempt_at    TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  report             JSONB,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT stripe_catalog_recoveries_status_chk CHECK (status IN ('WAITING', 'RUNNING', 'RETRY_WAIT', 'DONE', 'FAILED', 'CHECK_FAILED')),
  CONSTRAINT stripe_catalog_recoveries_uniq UNIQUE (catalog_context, recovery_key)
);
