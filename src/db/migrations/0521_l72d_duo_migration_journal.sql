-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0521 : journal du rattrapage BO « Premium Duo — compte partagé »
-- (lot 72D, bloc Exploitation › Rattrapages `duo-shared-account`).
--
-- Une ligne par écriture APPLIQUÉE (la simulation n'écrit rien) : exécution,
-- action, entité, état avant / après. La restauration (`restore`) rejoue le
-- journal à l'envers et pose `restored_at`.
--
--   action  MEMBERSHIP_OWNER_CREATED | MEMBERSHIP_MEMBER_CREATED |
--           MEMBERSHIP_MEMBER_REACTIVATED | ACCOUNT_ARCHIVED |
--           USER_PLAN_TYPE_FIXED | LAST_SELECTED_SET
--   entity  account_membership | account | user | asset |
--           asset_move_request | asset_delete_request (0522)
--
-- Idempotente (IF NOT EXISTS). Table nouvelle : aucun verrou sur l'existant.
-- Retour arrière : DROP TABLE (rien n'en dépend).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS duo_shared_account_journal (
  id           bigserial PRIMARY KEY,
  run_id       uuid NOT NULL,
  action       text NOT NULL,
  entity       text NOT NULL,
  entity_id    integer NOT NULL,
  account_id   integer,
  user_id      integer,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  restored_at  timestamptz,
  CONSTRAINT duo_shared_account_journal_entity_chk CHECK (entity IN ('account_membership', 'account', 'user', 'asset', 'asset_move_request', 'asset_delete_request'))
);

CREATE INDEX IF NOT EXISTS duo_shared_account_journal_run_idx ON duo_shared_account_journal (run_id);

COMMENT ON TABLE duo_shared_account_journal IS
  'Lot 72D : écritures du rattrapage BO duo-shared-account (avant / après), restaurables par exécution.';
