-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0144 — La trace d'une suppression de compte survit au compte
--
-- `scheduled_account_deletions.account_id` référençait `accounts(id)` ON
-- DELETE CASCADE : la suppression du compte emportait son propre compte à
-- rebours, et la réécriture de la trace « EXECUTED » échouait ensuite sur la
-- clé étrangère (le compte n'existe plus). La suppression était faite, mais
-- rapportée en échec, et sans trace (§17).
--
-- La clé étrangère est retirée : `account_id` reste l'identifiant, historique,
-- du compte supprimé. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'scheduled_account_deletions'::regclass
       AND c.contype = 'f'
       AND a.attname = 'account_id'
  LOOP
    EXECUTE format('ALTER TABLE scheduled_account_deletions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
