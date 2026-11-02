-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0900 — Lot 102A : cycle de vie des comptes (états restreints,
-- conservation 90 jours, purge, registre de rejeu après restauration).
--
-- 1. Nouveau motif de compte à rebours 'SUBSCRIPTION_ENDED' : fin effective
--    d'un abonnement payant → lecture seule + purge à +90 jours (origine
--    système), annulée par une nouvelle souscription.
-- 2. Registre MINIMAL des suppressions exécutées (`account_deletion_registry`) :
--    identifiants internes seulement (aucune adresse, aucun nom), pour
--    REJOUER une suppression après la restauration d'une sauvegarde antérieure
--    (procédure : docs/exploitation/procedure-restauration-suppressions.md).
--    Table conservée dans son état courant lors d'une restauration BO
--    (RESTORE_KEEP_CURRENT_TABLES) ; purgée après la rotation des sauvegardes.
--
-- Additive et idempotente : rejouée, elle ne change rien. Aucune donnée
-- existante n'est modifiée.
-- ═══════════════════════════════════════════════════════════════════════════
SET LOCAL lock_timeout = '5s';

ALTER TABLE scheduled_account_deletions DROP CONSTRAINT IF EXISTS scheduled_deletions_reason_check;
ALTER TABLE scheduled_account_deletions ADD CONSTRAINT scheduled_deletions_reason_check CHECK (reason IN (
  'WITHDRAWAL',          -- rétractation : lecture seule, purge à +90 jours (lot 102A)
  'VOLUNTARY',           -- demande explicite du titulaire : suppression au plus tôt
  'TRIAL_ABANDONED',     -- fin d'essai sans souscription : purge à +90 jours (lot 102A)
  'ADMIN',               -- suppression déclenchée depuis le back-office (ACC-A14)
  'UNPAID',              -- J+90 d'un impayé non régularisé (GAP-06)
  'SUBSCRIPTION_ENDED'   -- fin d'abonnement payant : purge à +90 jours (lot 102A)
));

CREATE TABLE IF NOT EXISTS account_deletion_registry (
  id               SERIAL PRIMARY KEY,
  -- Compte à rebours exécuté (trace conservée, sans clé étrangère).
  schedule_id      INTEGER,
  reason           TEXT        NOT NULL,
  scope            TEXT        NOT NULL DEFAULT 'account',
  -- Identifiants internes supprimés : utilisateurs et comptes du périmètre.
  user_ids         INTEGER[]   NOT NULL DEFAULT '{}',
  account_ids      INTEGER[]   NOT NULL DEFAULT '{}',
  executed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'execution' (purge d'origine) | 'replay' (rejouée après restauration).
  source           TEXT        NOT NULL DEFAULT 'execution',
  replay_count     INTEGER     NOT NULL DEFAULT 0,
  last_replayed_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_deletion_registry_scope_check CHECK (scope IN ('account', 'user')),
  CONSTRAINT account_deletion_registry_source_check CHECK (source IN ('execution', 'replay'))
);

CREATE INDEX IF NOT EXISTS account_deletion_registry_executed_idx ON account_deletion_registry (executed_at);

COMMENT ON TABLE account_deletion_registry IS
  'Lot 102A : registre minimal des suppressions exécutées (identifiants internes uniquement), pour rejouer une suppression après restauration d''une sauvegarde. Purgé après la rotation des sauvegardes.';
