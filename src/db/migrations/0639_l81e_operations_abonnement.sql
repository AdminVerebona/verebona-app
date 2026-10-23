-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0639 : communications d'abonnement décidées PAR OPÉRATION et
-- confirmations contractuelles DURABLES (lot 81E).
--
--   1. subscription_communication_operations — une ligne par transition
--      métier d'abonnement (activation, changement d'offre, résiliation
--      programmée, prise d'effet de la résiliation, changement BO), identifiée
--      par une clé STABLE (`operation_key` : compte, abonnement, opération,
--      ancien/nouveau statut, ancienne/nouvelle offre, date d'effet). Écrite
--      dans la transaction qui applique la transition : plusieurs webhooks
--      (simultanés, rejoués, désordonnés) ne produisent qu'une ligne, donc
--      qu'une communication par opération ; deux opérations distinctes du
--      même utilisateur (même dans la journée) restent distinctes. Plus
--      aucune déduplication « e-mail récent au même utilisateur ».
--   2. transactional_email_jobs.kind accepte PREMIUM_CONFIRMATION
--      (confirmation contractuelle sur support durable) et
--      DOWNGRADE_NOTIFICATION (fin d'offre) : la file DURABLE des lots
--      57A / 72F (reprise, clé d'idempotence stable, acceptation incertaine,
--      supervision BO) remplace l'envoi « fire and forget ».
--
-- Pas de bien ni de fichier : hors classement des transferts de biens.
-- Idempotente. Retour arrière : table ignorée ; l'ancien code clôt sans envoi
-- (`UNKNOWN_KIND`) une demande de ces deux types restée en file.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS subscription_communication_operations (
  id                     serial PRIMARY KEY,
  operation_key          text        NOT NULL,
  account_id             integer     REFERENCES accounts(id) ON DELETE SET NULL,
  owner_user_id          integer     REFERENCES users(id) ON DELETE SET NULL,
  stripe_subscription_id text,
  kind                   text        NOT NULL,
  old_plan               text,
  new_plan               text,
  old_status             text,
  new_status             text,
  effective_at           timestamptz,
  source                 text,
  -- Communications décidées pour cette opération (traçabilité BO).
  notification_type      text,
  notification_dedupe_key text,
  email_job_id           integer,
  communications_skipped text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_communication_operations_kind_check
    CHECK (kind IN ('ACTIVATION', 'PLAN_CHANGE', 'CANCELLATION_SCHEDULED', 'CANCELLATION_EFFECTIVE', 'ADMIN_PLAN_CHANGE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_communication_operations_key_idx
  ON subscription_communication_operations (operation_key);
CREATE INDEX IF NOT EXISTS subscription_communication_operations_account_idx
  ON subscription_communication_operations (account_id, created_at DESC);

ALTER TABLE transactional_email_jobs DROP CONSTRAINT IF EXISTS transactional_email_jobs_kind_check;
ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check
  CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT',
                  'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', 'DUO_INVITATION_DECLINED',
                  'PREMIUM_CONFIRMATION', 'DOWNGRADE_NOTIFICATION'));
