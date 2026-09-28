-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0206 — Suppression volontaire du compte, différée de 30 jours
-- (décision produit ; CDC Back-Office V1 ACC-A14, GDP-007/008 ; Centre
-- d'aide AID-ACCOUNT-006).
--
-- 1. `users.status` admet `PENDING_DELETION` : compte CLÔTURÉ par son
--    utilisateur, en attente de suppression. La session ne donne plus accès
--    qu'à l'écran « compte en cours de suppression » (annulation, export).
--
-- 2. `scheduled_account_deletions` :
--      · `scope` — `account` (historique : rétractation, impayé, admin,
--        essai abandonné — tout le compte ET tous ses utilisateurs) ou `user`
--        (suppression volontaire : l'UTILISATEUR demandeur et les comptes dont
--        il est titulaire ; un second utilisateur n'est jamais emporté) ;
--      · `notify_email` / `final_email_sent_at` — confirmation finale après
--        suppression : l'adresse est relevée juste avant l'exécution (la
--        ligne utilisateur disparaît) puis effacée dès l'envoi ;
--      · l'unicité « un compte à rebours actif » devient : un par COMPTE pour
--        la portée `account`, un par UTILISATEUR pour la portée `user` (deux
--        membres d'un même espace peuvent demander chacun la suppression de
--        leur propre compte utilisateur).
--
-- 3. `invoices` (registre local des factures Stripe) SURVIT à la suppression
--    du compte : obligation de conservation des pièces comptables (10 ans,
--    art. L123-22 du Code de commerce). Les liens vers l'utilisateur et le
--    compte tombent à NULL (ON DELETE SET NULL) ; montants, dates, offre et
--    identifiants Stripe restent, ce qui préserve aussi le CA encaissé du BO
--    (DOV-001). Jusqu'ici la cascade effaçait ces lignes.
--
-- 4. Modèles d'e-mail : `notif_account_deletion` (clôture et rappel J-7, via
--    le moteur de notifications) et `account_deletion_completed`
--    (confirmation finale, envoi direct : l'utilisateur n'existe plus).
--
-- Idempotente : peut être rejouée sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Statut utilisateur ────────────────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_status;
ALTER TABLE users ADD CONSTRAINT chk_users_status
  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED', 'PENDING_DELETION'));

-- 2. Portée et confirmation finale des suppressions planifiées ─────────────
ALTER TABLE scheduled_account_deletions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'account';
ALTER TABLE scheduled_account_deletions ADD COLUMN IF NOT EXISTS notify_email TEXT;
ALTER TABLE scheduled_account_deletions ADD COLUMN IF NOT EXISTS final_email_sent_at TIMESTAMPTZ;
-- Reprise d'une suppression volontaire en échec : tentatives et prochain
-- essai (délai croissant) ; `processing_started_at` réserve l'exécution en
-- cours (l'annulation est alors refusée) ; `anomaly_reported_at` : anomalie
-- signalée une seule fois (arriéré non exécuté, utilisateur non clôturé).
ALTER TABLE scheduled_account_deletions ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_account_deletions ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE scheduled_account_deletions ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE scheduled_account_deletions ADD COLUMN IF NOT EXISTS anomaly_reported_at TIMESTAMPTZ;

ALTER TABLE scheduled_account_deletions DROP CONSTRAINT IF EXISTS scheduled_deletions_scope_check;
ALTER TABLE scheduled_account_deletions ADD CONSTRAINT scheduled_deletions_scope_check
  CHECK (scope IN ('account', 'user'));

-- NB : pas de contrainte « portée user ⇒ user_id renseigné » : une
-- suppression admin du compte titulaire peut emporter l'utilisateur (SET
-- NULL) alors que son compte à rebours est encore actif ; l'exécution le
-- constate et clôt la trace (USER_ALREADY_GONE).

DROP INDEX IF EXISTS scheduled_deletions_active_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_deletions_active_account_uidx
  ON scheduled_account_deletions (account_id)
  WHERE status = 'SCHEDULED' AND scope = 'account';
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_deletions_active_user_uidx
  ON scheduled_account_deletions (user_id)
  WHERE status = 'SCHEDULED' AND scope = 'user';

-- Confirmations finales restant à envoyer (balayage quotidien).
CREATE INDEX IF NOT EXISTS scheduled_deletions_final_email_idx
  ON scheduled_account_deletions (executed_at)
  WHERE notify_email IS NOT NULL AND final_email_sent_at IS NULL;

-- 3. Registre des factures conservé ────────────────────────────────────────
ALTER TABLE invoices ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN user_id DROP NOT NULL;

DO $$
DECLARE c RECORD;
BEGIN
  -- Clés étrangères existantes vers `accounts` / `users`, quel que soit leur
  -- nom (créées par drizzle-kit ou par une migration antérieure).
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'invoices'::regclass AND contype = 'f'
       AND confrelid IN ('accounts'::regclass, 'users'::regclass)
       AND confdeltype <> 'n'
  LOOP
    EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I', c.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'invoices'::regclass AND contype = 'f'
       AND confrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_account_id_accounts_id_fk
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'invoices'::regclass AND contype = 'f'
       AND confrelid = 'users'::regclass
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Modèles d'e-mail ──────────────────────────────────────────────────────
INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('notif_account_deletion', 'Suppression de votre compte Verebona',
   E'{{body}}\n\nAnnuler la suppression ou exporter vos données : {{actionUrl}}',
   '["title","body","actionUrl"]', NOW()),
  ('account_deletion_completed', 'Votre compte Verebona a été supprimé',
   E'Bonjour,\n\nComme vous l’avez demandé le {{requestedAt}}, votre compte Verebona et les données qui y étaient rattachées (biens, documents, fichiers, échéances, historique de l’assistant) ont été définitivement supprimés le {{deletedAt}}.\n\nSeules les informations que la loi nous impose de conserver, ou qui prouvent le traitement de votre demande, le sont encore, détachées de votre compte et sans servir à autre chose : les factures, les preuves d’acceptation des conditions générales, vos éventuelles demandes de rétractation, ainsi que la trace de votre demande de suppression et son inscription au registre des demandes RGPD (sans votre adresse e-mail).\n\nCet e-mail est le dernier que vous recevrez de notre part. Merci d’avoir utilisé Verebona.',
   '["requestedAt","deletedAt"]', NOW())
ON CONFLICT (type) DO NOTHING;
