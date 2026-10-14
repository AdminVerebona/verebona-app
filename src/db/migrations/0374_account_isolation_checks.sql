-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0374 : historique des contrôles « Isolation des comptes »
-- (lot 54, ticket SEC-P0-CORR, SEC-07 « Fiabiliser la supervision »,
-- SEC-08 « BO › Exploitation › Isolation des comptes »).
--
-- Une ligne par exécution du contrôle (tâche quotidienne 7 h 05, lancement
-- manuel depuis le BO, lecture BO) : état global à TROIS valeurs
--   CONFORME   tous les contrôles exécutés ET tous les compteurs à 0 ;
--   ANOMALIES  tous les contrôles exécutés, au moins un compteur non nul ;
--   INCOMPLET  au moins un contrôle non exécuté (jamais « conforme ») ;
-- décomptes par catégorie, contrôles en échec (motif), comptes concernés,
-- anomalies de Supervision ouvertes / résolues. Sert à l'écran BO
-- (dernier contrôle complet réussi, historique) et de preuve.
--
-- Table neuve et vide : création instantanée ; index secondaire construit
-- CONCURRENTLY dans 0374_account_isolation_checks_idx_1.sql.
-- Idempotente (IF NOT EXISTS). Retour arrière : DROP TABLE IF EXISTS
-- account_isolation_checks (l'écran indique alors l'historique indisponible).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS account_isolation_checks (
  id             BIGSERIAL   PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger        TEXT        NOT NULL,
  status         TEXT        NOT NULL,
  total          INTEGER     NOT NULL DEFAULT 0,
  checks_total   INTEGER     NOT NULL DEFAULT 0,
  checks_failed  INTEGER     NOT NULL DEFAULT 0,
  counts         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  errors         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  account_ids    INTEGER[]   NOT NULL DEFAULT '{}',
  reported       INTEGER     NOT NULL DEFAULT 0,
  resolved       INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT account_isolation_checks_status_ck CHECK (status IN ('CONFORME', 'ANOMALIES', 'INCOMPLET')),
  CONSTRAINT account_isolation_checks_trigger_ck CHECK (trigger IN ('scheduled', 'manual', 'bo'))
);
