-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0530 : « Refuser l'invitation » Premium Duo (lot 73B, décision PO
-- du 20/10/2026, point 4).
--
--   1. duo_accounts — dernier REFUS de l'invitation :
--        · last_declined_invite_email  adresse invitée (affichée au titulaire,
--                                      qui l'a lui-même saisie) ;
--        · last_declined_at            date du refus (panneau « Refusée ») ;
--        · last_declined_invite_token_hash  empreinte SHA-256 du jeton refusé
--                                      (« invitation refusée » distinguée d'un
--                                      lien inconnu) — jamais le jeton.
--      Le jeton refusé est retiré de `pending_invite_token` : il ne permet
--      plus ni de rejoindre, ni de s'inscrire.
--   2. transactional_email_jobs.kind accepte DUO_INVITATION_DECLINED
--      (information du titulaire, file DURABLE, clé d'idempotence `dedupe_key`
--      de la 0459 : un refus = un Duo × une invitation).
--   3. Gabarit DUO_INVITATION_DECLINED créé s'il MANQUE seulement : compatible
--      avec la garde 0483 (le déclencheur d'insertion pose le texte livré
--      `shipped_*`) ; un gabarit déjà présent — a fortiori personnalisé dans
--      l'éditeur du BO — n'est jamais modifié.
--
-- Variables : {{firstName}} (titulaire), {{inviteEmail}}, {{declinedAt}},
-- {{invitationUrl}} (Mon compte › panneau d'invitation).
-- Idempotente (IF NOT EXISTS, contrainte remplacée sous le même nom, NOT
-- EXISTS). Aucun index CONCURRENTLY (lecture par empreinte : une table d'un
-- Duo par titulaire, lue seulement quand le jeton n'est plus en attente).
-- Retour arrière : colonnes ignorées par l'ancien code ; une demande
-- DUO_INVITATION_DECLINED restée en file est close sans envoi (UNKNOWN_KIND).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS last_declined_invite_email text;
ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS last_declined_at timestamptz;
ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS last_declined_invite_token_hash text;

ALTER TABLE transactional_email_jobs DROP CONSTRAINT IF EXISTS transactional_email_jobs_kind_check;
ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check
  CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', 'DUO_INVITATION_DECLINED'));

INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
SELECT 'DUO_INVITATION_DECLINED',
       'Votre invitation Premium Duo a été refusée',
       E'Bonjour {{firstName}},\n\nLa personne que vous avez invitée à rejoindre votre espace Premium Duo ({{inviteEmail}}) a refusé l''invitation le {{declinedAt}}.\n\nLe lien d''invitation n''est plus valable. Votre espace, vos biens et vos documents ne sont pas modifiés.\n\nVous pouvez inviter de nouveau cette personne, ou une autre, depuis Mon compte, rubrique Mon abonnement.\n\nGérer mon invitation : {{invitationUrl}}\n\nCordialement,\nL''équipe Verebona',
       '["firstName","inviteEmail","declinedAt","invitationUrl"]',
       now()
 WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'DUO_INVITATION_DECLINED');
