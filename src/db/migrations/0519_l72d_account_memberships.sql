-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0519 : adhésions utilisateur ↔ compte, source de vérité des accès
-- (lot 72D, ticket P0 « Premium Duo — compte partagé »). SCHÉMA ADDITIF.
--
--   account_memberships
--     · statut `left` (départ volontaire) ajouté au CHECK ;
--     · last_selected_at : dernier espace choisi (ouverture de session sur le
--       dernier compte encore accessible) ;
--     · source : origine de l'adhésion (signup | account_invitation |
--       duo_invitation | migration_72d | admin) ;
--     · ended_reason : motif de fin (left | removed | offer_ended | withdrawal |
--       restore_72d …) ;
--     · permissions : réservé à la future offre Pro (non lu en 72D).
--   accounts
--     · archived_at / archived_reason : neutralisation RÉVERSIBLE des comptes
--       artificiels vides créés aux invités Duo (décision PO Q9) — jamais de
--       suppression physique.
--
-- Idempotente (IF NOT EXISTS ; contrainte retirée puis reposée NOT VALID puis
-- validée). Retour arrière : l'ancien code ignore les colonnes ; le statut
-- `left` n'est écrit que par le nouveau code et vaut « inactif » pour l'ancien.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE account_memberships ADD COLUMN IF NOT EXISTS last_selected_at timestamptz;
ALTER TABLE account_memberships ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE account_memberships ADD COLUMN IF NOT EXISTS ended_reason text;
ALTER TABLE account_memberships ADD COLUMN IF NOT EXISTS permissions jsonb;

ALTER TABLE account_memberships DROP CONSTRAINT IF EXISTS account_memberships_status_check;
ALTER TABLE account_memberships ADD CONSTRAINT account_memberships_status_check
  CHECK (status IN ('pending', 'active', 'removed', 'declined', 'left')) NOT VALID;
ALTER TABLE account_memberships VALIDATE CONSTRAINT account_memberships_status_check;

ALTER TABLE account_memberships DROP CONSTRAINT IF EXISTS account_memberships_source_check;
ALTER TABLE account_memberships ADD CONSTRAINT account_memberships_source_check
  CHECK (source IS NULL OR source IN ('signup', 'account_invitation', 'duo_invitation', 'migration_72d', 'admin')) NOT VALID;
ALTER TABLE account_memberships VALIDATE CONSTRAINT account_memberships_source_check;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived_reason text;

COMMENT ON COLUMN account_memberships.last_selected_at IS
  'Lot 72D : dernier choix de cet espace par l''utilisateur (ouverture de session sur le dernier espace accessible).';
COMMENT ON COLUMN accounts.archived_at IS
  'Lot 72D : compte neutralisé (masqué, non sélectionné, sans notification d''essai ni de facturation), restaurable. Aucune donnée effacée.';
