-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0385 : début effectif de l'abonnement Premium Duo et trace durable
-- du premier envoi d'invitation (lot 54F — mascotte « Inviter quelqu'un »
-- limitée au premier mois de l'abonnement Duo).
--
--   duo_accounts.duo_subscription_started_at
--       Prise d'effet RÉELLE de la souscription Duo en cours. Distincte de
--       `activated_at` (partage entre membres), de `created_at` (compte Duo
--       technique créé AVANT paiement, statut CANCELED), de
--       `accounts.subscription_started_at` (peut dater d'un Standard/Premium
--       antérieur) et du début de la période de facturation.
--
--   duo_accounts.duo_first_invite_sent_at
--       Premier envoi d'invitation de cette souscription. Contrairement à
--       `pending_invite_sent_at`, ni l'annulation ni l'expiration du lien ne
--       l'effacent.
--
--   Déclencheur `duo_accounts_subscription_period` (BEFORE INSERT / UPDATE OF
--   subscription_status) : TOUS les chemins qui activent un Duo (Checkout puis
--   synchronisation, Premium → Duo, webhooks, resynchronisation BO,
--   changement d'offre BO `applyPlanChange`) passent par l'écriture du statut.
--   Règle unique, idempotente :
--     - passage à ACTIVE/TRIALING depuis un état HORS offre (insertion,
--       CANCELED, EXPIRED…) = nouvelle souscription : début = now(), trace
--       d'invitation remise à NULL ;
--     - ACTIVE ↔ TRIALING ↔ UNPAID_RECOVERY (renouvellement, rejeu de webhook,
--       resynchronisation, impayé régularisé, changement de périodicité) :
--       RIEN ne change ;
--     - une valeur posée explicitement dans la même écriture est respectée.
--
--   Reprise de l'existant (idempotente, ne remplit que les NULL) :
--     - début = dernier passage À Premium Duo (depuis une autre offre) de
--       l'historique des changements d'offre du compte payeur, pour un Duo
--       encore dans l'offre (ACTIVE/TRIALING/UNPAID_RECOVERY) et sans sortie
--       de Premium Duo postérieure ; sinon NULL (pas d'affichage : aucune
--       période d'invitation relancée à la date de migration) ;
--     - trace d'invitation = plus ancien indice fiable de la souscription :
--       invitation en cours, adhésion d'un autre utilisateur, courriel
--       DUO_INVITATION journalisé pour le payeur.
--
-- Pas d'index (lecture par clé primaire). Retour arrière :
--   DROP TRIGGER IF EXISTS duo_accounts_subscription_period ON duo_accounts;
--   DROP FUNCTION IF EXISTS duo_accounts_subscription_period();
--   ALTER TABLE duo_accounts DROP COLUMN IF EXISTS duo_subscription_started_at,
--     DROP COLUMN IF EXISTS duo_first_invite_sent_at;
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS duo_subscription_started_at TIMESTAMPTZ;
ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS duo_first_invite_sent_at TIMESTAMPTZ;

-- ── Reprise : début effectif d'après l'historique fiable ────────────────────
UPDATE duo_accounts d
   SET duo_subscription_started_at = src.started_at
  FROM (
    SELECT d2.id,
           (SELECT max(h.created_at)
              FROM subscription_history h
             WHERE (h.account_id = a.id OR (h.account_id IS NULL AND h.user_id = d2.billing_owner_user_id))
               AND upper(h.new_tier) = 'PREMIUM_DUO'
               AND upper(coalesce(h.old_tier, '')) <> 'PREMIUM_DUO') AS started_at,
           a.id AS account_id
      FROM duo_accounts d2
      JOIN accounts a ON a.duo_account_id = d2.id AND a.owner_user_id = d2.billing_owner_user_id
     WHERE d2.subscription_status IN ('ACTIVE', 'TRIALING', 'UNPAID_RECOVERY')
  ) src
 WHERE d.id = src.id
   AND d.duo_subscription_started_at IS NULL
   AND src.started_at IS NOT NULL
   -- Aucune sortie de Premium Duo enregistrée après ce passage.
   AND NOT EXISTS (
     SELECT 1 FROM subscription_history h2
      WHERE (h2.account_id = src.account_id OR (h2.account_id IS NULL AND h2.user_id = d.billing_owner_user_id))
        AND upper(coalesce(h2.old_tier, '')) = 'PREMIUM_DUO'
        AND upper(h2.new_tier) <> 'PREMIUM_DUO'
        AND h2.created_at > src.started_at);

-- ── Reprise : premier envoi d'invitation de la souscription ─────────────────
UPDATE duo_accounts d
   SET duo_first_invite_sent_at = src.first_sent
  FROM (
    SELECT d2.id,
           LEAST(
             d2.pending_invite_sent_at,
             CASE WHEN d2.pending_invite_email IS NOT NULL THEN coalesce(d2.pending_invite_sent_at, d2.updated_at) END,
             (SELECT min(coalesce(m.invited_at, m.created_at))
                FROM duo_memberships m
               WHERE m.duo_id = d2.id AND m.user_id <> d2.billing_owner_user_id
                 AND (d2.duo_subscription_started_at IS NULL OR m.left_at IS NULL
                      OR m.left_at >= d2.duo_subscription_started_at)),
             (SELECT min(l.sent_at)
                FROM email_logs l
               WHERE l.template_code = 'DUO_INVITATION'
                 AND l.recipient_user_id = d2.billing_owner_user_id
                 AND (d2.duo_subscription_started_at IS NULL OR l.sent_at >= d2.duo_subscription_started_at))
           ) AS first_sent
      FROM duo_accounts d2
  ) src
 WHERE d.id = src.id
   AND d.duo_first_invite_sent_at IS NULL
   AND src.first_sent IS NOT NULL;

-- ── Déclencheur : une seule règle pour tous les chemins d'activation ───────
CREATE OR REPLACE FUNCTION duo_accounts_subscription_period() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subscription_status IN ('ACTIVE', 'TRIALING') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.duo_subscription_started_at := coalesce(NEW.duo_subscription_started_at, now());
    ELSIF OLD.subscription_status IS NULL
       OR OLD.subscription_status NOT IN ('ACTIVE', 'TRIALING', 'UNPAID_RECOVERY') THEN
      -- Nouvelle souscription après sortie de l'offre : nouvelle période.
      IF NEW.duo_subscription_started_at IS NOT DISTINCT FROM OLD.duo_subscription_started_at THEN
        NEW.duo_subscription_started_at := now();
      END IF;
      IF NEW.duo_first_invite_sent_at IS NOT DISTINCT FROM OLD.duo_first_invite_sent_at THEN
        NEW.duo_first_invite_sent_at := NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS duo_accounts_subscription_period ON duo_accounts;
CREATE TRIGGER duo_accounts_subscription_period
  BEFORE INSERT OR UPDATE OF subscription_status ON duo_accounts
  FOR EACH ROW EXECUTE FUNCTION duo_accounts_subscription_period();
