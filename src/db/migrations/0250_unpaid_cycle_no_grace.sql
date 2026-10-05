-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0250 : fin de l'ancienne « période de grâce » — cycle d'impayé
-- unique (APP-FUNC-31, Centre d'aide GAP-06 / AID-BILL-008).
--
-- RÈGLE : échec de paiement → compte restreint IMMÉDIATEMENT (lecture,
-- export, transmission ; ni écriture ni fonctions payantes) → délai de
-- régularisation / conservation (J+90) → régularisation ou suppression par
-- le balayage `billing-unpaid`. Aucun délai ne maintient les droits normaux.
--
-- ── CORRESPONDANCES ──────────────────────────────────────────────────────────
--
--   accounts.past_due_grace_started_at  → accounts.unpaid_started_at
--   accounts.past_due_grace_ends_at     → accounts.unpaid_recovery_ends_at
--       (elles portaient DÉJÀ J0 et J+90 depuis 0182 : simple renommage du
--        vocabulaire, aucune date recalculée)
--   accounts.subscription_status
--       PAST_DUE_GRACE, UNPAID_RECOVERY → PAST_DUE  (impayé, restreint)
--   duo_accounts.subscription_status
--       PAST_DUE_GRACE                  → UNPAID_RECOVERY (impayé Duo :
--                                         restreint, récupération ouverte)
--   duo_accounts.grace_deadline_at (15 j de grâce, sans objet)
--       → duo_accounts.unpaid_recovery_ends_at = échéance du cycle du compte
--         payeur (à défaut : 1er échec + 90 j, au moins J+30 du déploiement)
--
-- Compte en PAST_DUE_GRACE SANS J0 (cycle antérieur à 0182 resté incomplet) :
-- J0 = date de dernière mise à jour, échéance au plus tôt 30 jours après le
-- déploiement (même lecture prudente que 0182 : aucune suppression sans
-- préavis J-7 / J-1).
--
-- Droits : une ligne `account_subscriptions` encore `active` pour un compte
-- en impayé (vestige de la grâce) passe `past_due` — c'est elle que lisent
-- les entitlements. Aucune autre ligne n'est touchée.
--
-- ── SÉCURITÉ / RETOUR ARRIÈRE ────────────────────────────────────────────────
--
-- · Aucune donnée supprimée : les anciennes colonnes (`past_due_grace_*`,
--   `grace_deadline_at`) sont CONSERVÉES et tenues synchronisées par un
--   déclencheur de compatibilité, le temps que plus aucune instance de
--   l'ancien code ne tourne (déploiement progressif, retour arrière). Leur
--   suppression fera l'objet d'une migration ultérieure (contraction).
-- · L'ancien code qui écrirait encore PAST_DUE_GRACE / UNPAID_RECOVERY est
--   normalisé par le même déclencheur (PAST_DUE / UNPAID_RECOVERY) : la
--   nouvelle contrainte ne fait échouer aucun webhook pendant la bascule.
-- · Chaque ligne modifiée est sauvegardée, avec ses valeurs d'avant, dans
--   `migration_0250_unpaid_backup` (une ligne par objet, première valeur
--   seulement : une réexécution n'écrase rien).
-- · Retour arrière documenté (à exécuter manuellement, dans cet ordre) :
--     DROP TRIGGER IF EXISTS accounts_unpaid_compat_trg ON accounts;
--     DROP TRIGGER IF EXISTS duo_accounts_unpaid_compat_trg ON duo_accounts;
--     ALTER TABLE accounts DROP CONSTRAINT accounts_subscription_status_check;
--     ALTER TABLE accounts ADD CONSTRAINT accounts_subscription_status_check CHECK (subscription_status IN
--       ('NONE','ACTIVE','CANCELED','EXPIRED','PAST_DUE','PAST_DUE_GRACE','UNPAID_RECOVERY','TRIALING','WITHDRAWN'));
--     UPDATE accounts a SET subscription_status = b.old_status FROM migration_0250_unpaid_backup b
--      WHERE b.entity = 'account' AND b.entity_id = a.id AND a.subscription_status = 'PAST_DUE';
--     UPDATE account_subscriptions s SET status = b.old_status FROM migration_0250_unpaid_backup b
--      WHERE b.entity = 'account_subscription' AND b.entity_id = s.account_id AND s.status = 'past_due';
--     UPDATE duo_accounts d SET subscription_status = b.old_status FROM migration_0250_unpaid_backup b
--      WHERE b.entity = 'duo_account' AND b.entity_id = d.id AND d.subscription_status = 'UNPAID_RECOVERY';
--   Les colonnes `past_due_grace_*` étant tenues à jour, l'ancien code
--   retrouve le cycle tel quel. Les nouvelles colonnes peuvent rester.
--
-- Idempotente : IF NOT EXISTS, COALESCE, CREATE OR REPLACE, contraintes
-- recréées à l'identique ; une seconde exécution ne modifie rien.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

-- ── 1. Nouvelles colonnes ────────────────────────────────────────────────────

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS unpaid_started_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unpaid_recovery_ends_at TIMESTAMPTZ;

ALTER TABLE duo_accounts
  ADD COLUMN IF NOT EXISTS unpaid_recovery_ends_at TIMESTAMPTZ;

COMMENT ON COLUMN accounts.unpaid_started_at IS
  'J0 du cycle d''impayé (premier échec de paiement non régularisé). NULL hors cycle. Ex-past_due_grace_started_at (0250).';
COMMENT ON COLUMN accounts.unpaid_recovery_ends_at IS
  'Fin du délai de régularisation/conservation (J+90) : suppression sans régularisation. N''ouvre AUCUN droit. Ex-past_due_grace_ends_at (0250).';
COMMENT ON COLUMN duo_accounts.unpaid_recovery_ends_at IS
  'Impayé Duo : fin du délai de récupération des biens par le membre (= échéance du cycle du compte payeur). NULL hors impayé.';

CREATE TABLE IF NOT EXISTS migration_0250_unpaid_backup (
  entity        TEXT        NOT NULL,   -- account | account_subscription | duo_account
  entity_id     INTEGER     NOT NULL,
  old_status    TEXT,
  old_started_at TIMESTAMPTZ,
  old_ends_at   TIMESTAMPTZ,
  migrated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity, entity_id)
);

-- ── 2. Sauvegarde des valeurs d'avant (première exécution seulement) ─────────

INSERT INTO migration_0250_unpaid_backup (entity, entity_id, old_status)
SELECT 'account', a.id, a.subscription_status
  FROM accounts a
 WHERE a.subscription_status IN ('PAST_DUE_GRACE', 'UNPAID_RECOVERY')
ON CONFLICT DO NOTHING;

INSERT INTO migration_0250_unpaid_backup (entity, entity_id, old_status)
SELECT 'account_subscription', s.account_id, s.status
  FROM account_subscriptions s
  JOIN accounts a ON a.id = s.account_id
 WHERE s.status = 'active'
   AND a.subscription_status IN ('PAST_DUE_GRACE', 'UNPAID_RECOVERY', 'PAST_DUE')
ON CONFLICT DO NOTHING;

-- `grace_deadline_at` n'existe que sur les bases historiques (colonne créée
-- hors migration SQL) : sauvegardée si présente.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'duo_accounts'
                AND column_name = 'grace_deadline_at') THEN
    INSERT INTO migration_0250_unpaid_backup (entity, entity_id, old_status, old_ends_at)
    SELECT 'duo_account', d.id, d.subscription_status, d.grace_deadline_at
      FROM duo_accounts d
     WHERE d.subscription_status = 'PAST_DUE_GRACE'
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO migration_0250_unpaid_backup (entity, entity_id, old_status)
    SELECT 'duo_account', d.id, d.subscription_status
      FROM duo_accounts d
     WHERE d.subscription_status = 'PAST_DUE_GRACE'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- ── 3. Dates du cycle : anciennes colonnes → nouvelles ───────────────────────
-- Les anciennes colonnes n'existent pas sur une base construite depuis le
-- schéma Drizzle sans 0070 : contrôle de présence.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'accounts'
                AND column_name = 'past_due_grace_started_at') THEN
    UPDATE accounts
       SET unpaid_started_at       = COALESCE(unpaid_started_at, past_due_grace_started_at),
           unpaid_recovery_ends_at = COALESCE(unpaid_recovery_ends_at, past_due_grace_ends_at)
     WHERE (past_due_grace_started_at IS NOT NULL AND unpaid_started_at IS NULL)
        OR (past_due_grace_ends_at IS NOT NULL AND unpaid_recovery_ends_at IS NULL);
  END IF;
END $$;

-- Impayé sans J0 (grâce historique incomplète) : cycle ouvert, avec préavis.
UPDATE accounts
   SET unpaid_started_at = COALESCE(updated_at, now())
 WHERE subscription_status IN ('PAST_DUE_GRACE', 'UNPAID_RECOVERY', 'PAST_DUE')
   AND unpaid_started_at IS NULL;

UPDATE accounts
   SET unpaid_recovery_ends_at = GREATEST(
         unpaid_started_at + interval '90 days',
         COALESCE(unpaid_recovery_ends_at, unpaid_started_at + interval '90 days'),
         now() + interval '30 days')
 WHERE unpaid_started_at IS NOT NULL
   AND (unpaid_recovery_ends_at IS NULL OR unpaid_recovery_ends_at < unpaid_started_at + interval '90 days');

-- ── 4. Statuts ───────────────────────────────────────────────────────────────

UPDATE accounts
   SET subscription_status = 'PAST_DUE'
 WHERE subscription_status IN ('PAST_DUE_GRACE', 'UNPAID_RECOVERY');

-- Plus de droits normaux pendant un impayé (CA-01, CA-02).
UPDATE account_subscriptions s
   SET status = 'past_due', updated_at = now()
  FROM accounts a
 WHERE a.id = s.account_id
   AND a.subscription_status = 'PAST_DUE'
   AND s.status = 'active';

UPDATE duo_accounts d
   SET subscription_status = 'UNPAID_RECOVERY'
 WHERE d.subscription_status = 'PAST_DUE_GRACE';

-- Échéance Duo = celle du cycle du compte payeur (même délai pour tous).
UPDATE duo_accounts d
   SET unpaid_recovery_ends_at = COALESCE(
         (SELECT a.unpaid_recovery_ends_at FROM accounts a
           WHERE a.duo_account_id = d.id AND a.unpaid_recovery_ends_at IS NOT NULL
           ORDER BY a.id LIMIT 1),
         (SELECT a.unpaid_recovery_ends_at FROM accounts a
           WHERE a.owner_user_id = d.billing_owner_user_id AND a.unpaid_recovery_ends_at IS NOT NULL
           ORDER BY a.id LIMIT 1),
         GREATEST(COALESCE(d.first_payment_failed_at, d.updated_at, now()) + interval '90 days',
                  now() + interval '30 days'))
 WHERE d.subscription_status = 'UNPAID_RECOVERY'
   AND d.unpaid_recovery_ends_at IS NULL;

-- ── 5. Contrainte : PAST_DUE_GRACE et UNPAID_RECOVERY sortent du modèle ──────

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_subscription_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_subscription_status_check
  CHECK (subscription_status IN (
    'NONE', 'TRIALING', 'ACTIVE', 'CANCELED', 'PAST_DUE', 'EXPIRED', 'WITHDRAWN'
  ));

-- ── 6. Compatibilité pendant la bascule (à retirer avec les anciennes colonnes)

CREATE OR REPLACE FUNCTION accounts_unpaid_compat() RETURNS TRIGGER AS $$
BEGIN
  -- Ancien code : statuts de grâce normalisés vers l'impayé unique.
  IF NEW.subscription_status IN ('PAST_DUE_GRACE', 'UNPAID_RECOVERY') THEN
    NEW.subscription_status := 'PAST_DUE';
  END IF;
  -- Dates du cycle tenues identiques dans les deux jeux de colonnes : la
  -- colonne modifiée par l'écrivain l'emporte.
  IF TG_OP = 'INSERT' THEN
    NEW.unpaid_started_at := COALESCE(NEW.unpaid_started_at, NEW.past_due_grace_started_at);
    NEW.unpaid_recovery_ends_at := COALESCE(NEW.unpaid_recovery_ends_at, NEW.past_due_grace_ends_at);
  ELSE
    IF NEW.past_due_grace_started_at IS DISTINCT FROM OLD.past_due_grace_started_at
       AND NEW.unpaid_started_at IS NOT DISTINCT FROM OLD.unpaid_started_at THEN
      NEW.unpaid_started_at := NEW.past_due_grace_started_at;
    END IF;
    IF NEW.past_due_grace_ends_at IS DISTINCT FROM OLD.past_due_grace_ends_at
       AND NEW.unpaid_recovery_ends_at IS NOT DISTINCT FROM OLD.unpaid_recovery_ends_at THEN
      NEW.unpaid_recovery_ends_at := NEW.past_due_grace_ends_at;
    END IF;
  END IF;
  NEW.past_due_grace_started_at := NEW.unpaid_started_at;
  NEW.past_due_grace_ends_at := NEW.unpaid_recovery_ends_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION duo_accounts_unpaid_compat() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.subscription_status = 'PAST_DUE_GRACE' THEN
    NEW.subscription_status := 'UNPAID_RECOVERY';
  END IF;
  IF NEW.subscription_status = 'UNPAID_RECOVERY' AND NEW.unpaid_recovery_ends_at IS NULL THEN
    NEW.unpaid_recovery_ends_at := COALESCE(NEW.first_payment_failed_at, now()) + interval '90 days';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  -- Déclencheur de comptes seulement si les anciennes colonnes existent.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'accounts'
                AND column_name = 'past_due_grace_started_at')
     AND EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'accounts'
                AND column_name = 'past_due_grace_ends_at') THEN
    DROP TRIGGER IF EXISTS accounts_unpaid_compat_trg ON accounts;
    CREATE TRIGGER accounts_unpaid_compat_trg
      BEFORE INSERT OR UPDATE ON accounts
      FOR EACH ROW EXECUTE FUNCTION accounts_unpaid_compat();
    -- Anciennes colonnes alignées une fois (le déclencheur s'en charge ensuite).
    UPDATE accounts
       SET past_due_grace_started_at = unpaid_started_at,
           past_due_grace_ends_at = unpaid_recovery_ends_at
     WHERE past_due_grace_started_at IS DISTINCT FROM unpaid_started_at
        OR past_due_grace_ends_at IS DISTINCT FROM unpaid_recovery_ends_at;
  END IF;
END $$;

DROP TRIGGER IF EXISTS duo_accounts_unpaid_compat_trg ON duo_accounts;
CREATE TRIGGER duo_accounts_unpaid_compat_trg
  BEFORE INSERT OR UPDATE ON duo_accounts
  FOR EACH ROW EXECUTE FUNCTION duo_accounts_unpaid_compat();

-- ── 7. Index du balayage quotidien sur la nouvelle colonne ───────────────────

DROP INDEX IF EXISTS accounts_past_due_grace_started_at_idx;
CREATE INDEX IF NOT EXISTS accounts_unpaid_started_at_idx
  ON accounts (unpaid_started_at)
  WHERE unpaid_started_at IS NOT NULL;
