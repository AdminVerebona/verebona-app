-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0438 : Premium Duo — écarts résiduels de « Inviter quelqu'un »
-- (lot 61B, ticket P1 « Corriger les écarts résiduels de la proposition
-- Inviter quelqu'un », corrige 0385 qui a pu être exécutée).
--
--   1. duo_accounts.duo_subscription_ended_at (D, A)
--      Sortie locale de l'offre Duo (passage d'un statut d'offre — ACTIVE,
--      TRIALING, UNPAID_RECOVERY — à un statut hors offre). Borne basse des
--      dates de début acceptées : une date Stripe antérieure à la dernière
--      sortie (webhook ancien, rejoué, marqueur BO d'une souscription
--      précédente) n'ouvre jamais la période en cours.
--
--   2. Déclencheur `duo_accounts_subscription_period` réécrit (D)
--      Il posait `now()` au passage à ACTIVE : une synchronisation Stripe
--      tardive repoussait la période d'invitation. Désormais il ne fabrique
--      AUCUNE date : à l'ouverture d'une nouvelle souscription, la date est
--      celle écrite par l'application dans la même écriture (source Stripe
--      fiable ou action BO locale), sinon NULL (aucune suggestion). La trace
--      d'invitation est remise à NULL (nouvelle souscription). À la sortie de
--      l'offre, `duo_subscription_ended_at` = now(). Renouvellement, rejeu,
--      impayé régularisé, changement de périodicité : rien ne change.
--
--   3. Attribution des e-mails DUO_INVITATION historiques (B)
--      Avant le lot 57 l'invitation était journalisée avec
--      `recipient_user_id` = le TITULAIRE (émetteur) alors qu'elle part à
--      l'invité. Preuve fiable d'une ligne de ce format : aucune demande
--      durable (`email_job_id` NULL), aucun émetteur (`triggered_by_user_id`
--      NULL), `recipient_user_id` = titulaire d'un Duo et adresse de
--      destination DIFFÉRENTE de celle du titulaire. Correction : émetteur =
--      titulaire ; destinataire = le compte de l'adresse invitée s'il est
--      unique, sinon NULL. Les autres lignes ne sont pas touchées.
--
--   4. Trace du premier envoi `duo_first_invite_sent_at` (B, E)
--      0385 la reprenait des e-mails dont le destinataire était le titulaire,
--      sans regarder le statut d'envoi. Preuves fiables d'un envoi PENDANT la
--      souscription en cours (≥ `duo_subscription_started_at` s'il est
--      connu) :
--        · demande durable DUO_INVITATION du Duo acceptée par Resend ;
--        · e-mail DUO_INVITATION accepté (`status = 'sent'`) rattaché au Duo
--          par sa demande durable, ou émis par le titulaire (seul Duo dont il
--          est payeur — jamais d'attribution ambiguë) ;
--        · adhésion d'un autre utilisateur pendant la souscription.
--      Trace vide : posée à la plus ancienne preuve. Trace existante remplacée
--      par la plus ancienne preuve (éventuellement NULL) UNIQUEMENT si elle
--      est prouvée fausse : antérieure au début de la souscription en cours,
--      ou égale à l'heure d'un e-mail dont le titulaire était le DESTINATAIRE
--      (invité par un autre Duo) ou d'un envoi ÉCHOUÉ, sans autre preuve
--      antérieure ou égale. Une trace valide n'est jamais effacée ; une
--      invitation acceptée puis annulée reste une trace (aucune réapparition).
--
-- Idempotente : colonne IF NOT EXISTS, fonction remplacée, corrections
-- d'attribution limitées aux lignes encore au format historique, traces
-- recalculées vers la même valeur au second passage. Pas d'index (lecture par
-- clé primaire, reprise unique).
--
-- Retour arrière : rejouer la fonction de 0385 ; la colonne est ignorée par
-- l'ancien code. Les attributions corrigées restent exactes.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS duo_subscription_ended_at TIMESTAMPTZ;

-- ── 1. Reprise de la sortie : Duo hors offre sans date de sortie ───────────
-- Dernière sortie de Premium Duo de l'historique du compte payeur, sinon la
-- dernière écriture du Duo (borne prudente : plus tardive que la sortie).
UPDATE duo_accounts d
   SET duo_subscription_ended_at = coalesce(
         (SELECT max(h.created_at)
            FROM subscription_history h
            JOIN accounts a ON a.owner_user_id = d.billing_owner_user_id
           WHERE (h.account_id = a.id OR (h.account_id IS NULL AND h.user_id = d.billing_owner_user_id))
             AND upper(coalesce(h.old_tier, '')) = 'PREMIUM_DUO'
             AND upper(coalesce(h.new_tier, '')) <> 'PREMIUM_DUO'),
         d.updated_at)
 WHERE d.duo_subscription_ended_at IS NULL
   AND d.subscription_status NOT IN ('ACTIVE', 'TRIALING', 'UNPAID_RECOVERY');

-- ── 2. Déclencheur : aucune date fabriquée ─────────────────────────────────
CREATE OR REPLACE FUNCTION duo_accounts_subscription_period() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Date fournie par l'application (Stripe / BO) ou NULL : jamais now().
    RETURN NEW;
  END IF;
  IF NEW.subscription_status IN ('ACTIVE', 'TRIALING')
     AND (OLD.subscription_status IS NULL
          OR OLD.subscription_status NOT IN ('ACTIVE', 'TRIALING', 'UNPAID_RECOVERY')) THEN
    -- Nouvelle souscription : date écrite dans la même écriture, sinon NULL.
    IF NEW.duo_subscription_started_at IS NOT DISTINCT FROM OLD.duo_subscription_started_at THEN
      NEW.duo_subscription_started_at := NULL;
    END IF;
    IF NEW.duo_first_invite_sent_at IS NOT DISTINCT FROM OLD.duo_first_invite_sent_at THEN
      NEW.duo_first_invite_sent_at := NULL;
    END IF;
  ELSIF OLD.subscription_status IN ('ACTIVE', 'TRIALING', 'UNPAID_RECOVERY')
        AND NEW.subscription_status NOT IN ('ACTIVE', 'TRIALING', 'UNPAID_RECOVERY') THEN
    -- Sortie de l'offre.
    NEW.duo_subscription_ended_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS duo_accounts_subscription_period ON duo_accounts;
CREATE TRIGGER duo_accounts_subscription_period
  BEFORE INSERT OR UPDATE OF subscription_status ON duo_accounts
  FOR EACH ROW EXECUTE FUNCTION duo_accounts_subscription_period();

-- ── 3. Attribution des e-mails DUO_INVITATION historiques ──────────────────
UPDATE email_logs l
   SET triggered_by_user_id = l.recipient_user_id,
       recipient_user_id = (
         SELECT CASE WHEN count(*) = 1 THEN min(u2.id) END
           FROM users u2
          WHERE lower(u2.email) = lower(l.recipient_email))
  FROM users owner
 WHERE l.template_code = 'DUO_INVITATION'
   AND l.email_job_id IS NULL
   AND l.triggered_by_user_id IS NULL
   AND l.recipient_user_id IS NOT NULL
   AND owner.id = l.recipient_user_id
   AND lower(owner.email) <> lower(l.recipient_email)
   AND EXISTS (SELECT 1 FROM duo_accounts d WHERE d.billing_owner_user_id = l.recipient_user_id);

-- ── 4. Trace du premier envoi : preuves fiables de la souscription en cours ─
WITH owners AS (
  SELECT billing_owner_user_id AS uid FROM duo_accounts GROUP BY billing_owner_user_id HAVING count(*) = 1
), ev AS (
  SELECT d.id,
         d.duo_first_invite_sent_at AS cur,
         d.duo_subscription_started_at AS s,
         LEAST(
           (SELECT min(j.accepted_at)
              FROM transactional_email_jobs j
             WHERE j.duo_id = d.id AND j.kind = 'DUO_INVITATION' AND j.status = 'accepted'
               AND j.accepted_at IS NOT NULL
               AND (d.duo_subscription_started_at IS NULL OR j.accepted_at >= d.duo_subscription_started_at)),
           (SELECT min(l.sent_at)
              FROM email_logs l
             WHERE l.template_code = 'DUO_INVITATION' AND l.status = 'sent' AND l.sent_at IS NOT NULL
               AND (d.duo_subscription_started_at IS NULL OR l.sent_at >= d.duo_subscription_started_at)
               AND (EXISTS (SELECT 1 FROM transactional_email_jobs j2 WHERE j2.id = l.email_job_id AND j2.duo_id = d.id)
                    OR (l.triggered_by_user_id = d.billing_owner_user_id
                        AND d.billing_owner_user_id IN (SELECT uid FROM owners)
                        AND NOT EXISTS (SELECT 1 FROM transactional_email_jobs j3
                                         WHERE j3.id = l.email_job_id AND j3.duo_id IS DISTINCT FROM d.id)))),
           (SELECT min(GREATEST(coalesce(m.invited_at, m.created_at),
                                coalesce(d.duo_subscription_started_at, coalesce(m.invited_at, m.created_at))))
              FROM duo_memberships m
             WHERE m.duo_id = d.id AND m.user_id <> d.billing_owner_user_id
               AND (d.duo_subscription_started_at IS NULL OR m.left_at IS NULL
                    OR m.left_at >= d.duo_subscription_started_at))
         ) AS e
    FROM duo_accounts d
), verdict AS (
  SELECT ev.id, ev.e,
         CASE
           WHEN ev.cur IS NULL THEN ev.e IS NOT NULL
           -- Trace d'une souscription précédente.
           WHEN ev.s IS NOT NULL AND ev.cur < ev.s THEN true
           -- Trace issue d'un e-mail REÇU par le titulaire (invité par un autre
           -- Duo) ou d'un envoi échoué, sans preuve d'envoi antérieure ou égale.
           WHEN (ev.e IS NULL OR ev.e > ev.cur)
                AND EXISTS (
                  SELECT 1 FROM email_logs l
                    JOIN duo_accounts d ON d.id = ev.id
                   WHERE l.template_code = 'DUO_INVITATION' AND l.sent_at = ev.cur
                     AND ((l.recipient_user_id = d.billing_owner_user_id
                           AND l.triggered_by_user_id IS NOT NULL
                           AND l.triggered_by_user_id <> d.billing_owner_user_id)
                          OR (l.status <> 'sent'
                              AND (l.triggered_by_user_id = d.billing_owner_user_id
                                   OR l.recipient_user_id = d.billing_owner_user_id))))
                AND NOT EXISTS (
                  SELECT 1 FROM email_logs l2
                    JOIN duo_accounts d2 ON d2.id = ev.id
                   WHERE l2.template_code = 'DUO_INVITATION' AND l2.sent_at = ev.cur AND l2.status = 'sent'
                     AND l2.triggered_by_user_id = d2.billing_owner_user_id)
             THEN true
           ELSE false
         END AS fix
    FROM ev
)
UPDATE duo_accounts d
   SET duo_first_invite_sent_at = v.e
  FROM verdict v
 WHERE d.id = v.id
   AND v.fix
   AND d.duo_first_invite_sent_at IS DISTINCT FROM v.e;
