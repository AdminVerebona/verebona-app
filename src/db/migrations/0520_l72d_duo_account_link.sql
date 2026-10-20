-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0520 : un Premium Duo est rattaché à un COMPTE (lot 72D).
--
-- `duo_accounts` était rattaché au titulaire UTILISATEUR
-- (`billing_owner_user_id`) ; le lien vers le compte partagé n'existait que
-- dans l'autre sens (`accounts.duo_account_id`). L'adhésion d'un invité doit
-- viser le compte : `duo_accounts.account_id`.
--
--   1. colonne `account_id` (FK accounts, ON DELETE SET NULL) ;
--   2. remplissage depuis `accounts.duo_account_id` quand UN seul compte porte
--      ce Duo ; sinon laissé NULL (cas « indécidable » rapporté par le
--      rattrapage BO duo-shared-account, INV-C) ;
--   3. déclencheur : tout compte qui reçoit `duo_account_id` (activation par
--      Stripe, BO, changement d'offre) renseigne le lien s'il est vide.
--
-- Les déclencheurs 0250/0385/0438 de `duo_accounts` ne sont pas touchés
-- (aucune écriture de `subscription_status` ici).
-- Idempotente. Retour arrière : l'ancien code ignore la colonne et le
-- déclencheur n'écrit que cette colonne.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS account_id integer;
ALTER TABLE duo_accounts DROP CONSTRAINT IF EXISTS duo_accounts_account_id_fkey;
ALTER TABLE duo_accounts ADD CONSTRAINT duo_accounts_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE duo_accounts VALIDATE CONSTRAINT duo_accounts_account_id_fkey;

UPDATE duo_accounts d
   SET account_id = x.account_id
  FROM (SELECT duo_account_id, min(id) AS account_id, count(*) AS n
          FROM accounts WHERE duo_account_id IS NOT NULL GROUP BY duo_account_id) x
 WHERE x.duo_account_id = d.id AND x.n = 1 AND d.account_id IS NULL;

CREATE OR REPLACE FUNCTION duo_accounts_link_account() RETURNS trigger AS $$
BEGIN
  IF NEW.duo_account_id IS NOT NULL THEN
    UPDATE duo_accounts SET account_id = NEW.id
     WHERE id = NEW.duo_account_id AND account_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounts_duo_link_trg ON accounts;
CREATE TRIGGER accounts_duo_link_trg
  AFTER INSERT OR UPDATE OF duo_account_id ON accounts
  FOR EACH ROW EXECUTE FUNCTION duo_accounts_link_account();

COMMENT ON COLUMN duo_accounts.account_id IS
  'Lot 72D : compte partagé du Duo (les membres y ont une adhésion account_memberships). NULL : indécidable, voir le rattrapage BO duo-shared-account.';
