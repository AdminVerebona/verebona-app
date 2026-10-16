-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0462 : e-mail au membre qui QUITTE lui-même un Premium Duo
-- (lot 65A, décision PO du 16/10/2026).
--
-- Le lot 64 (0459) informe le membre RETIRÉ (DUO_MEMBERSHIP_ENDED). Le membre
-- qui part de lui-même reçoit désormais une confirmation dédiée,
-- DUO_MEMBERSHIP_LEFT, par la même file DURABLE (transactional_email_jobs,
-- clé d'idempotence dedupe_key de la 0459, envoi par la tâche planifiée
-- interne transactional-emails-retry). Pas d'e-mail quand il quitte le Duo en
-- supprimant son propre compte (il reçoit déjà l'e-mail de suppression).
--
--   1. transactional_email_jobs.kind accepte DUO_MEMBERSHIP_LEFT ;
--   2. gabarit DUO_MEMBERSHIP_LEFT créé s'il manque (aperçu dans le BO ›
--      Communications, même régime que DUO_INVITATION ; jamais écrasé s'il
--      existe déjà).
--
-- Variables : {{firstName}} (membre), {{ownerFirstName}} (prénom du titulaire,
-- jamais son e-mail), {{accountUrl}}, {{subscriptionUrl}}.
-- Idempotente. Retour arrière : l'ancien code n'écrit jamais ce type, et clôt
-- sans envoi (cancelled) une demande DUO_MEMBERSHIP_LEFT restée en file.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE transactional_email_jobs DROP CONSTRAINT IF EXISTS transactional_email_jobs_kind_check;
ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check
  CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT'));

INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
SELECT 'DUO_MEMBERSHIP_LEFT',
       'Vous avez quitté l''espace Premium Duo',
       E'Bonjour {{firstName}},\n\nVous avez quitté l''espace Premium Duo que vous partagiez avec {{ownerFirstName}}. Votre départ a bien été pris en compte.\n\nCe qui change pour vous : vous n''avez plus accès à l''espace partagé, ni aux biens, documents et échéances qui y sont rattachés. Votre compte revient à votre propre offre (Standard si vous n''avez pas d''abonnement personnel).\n\nCe qui ne change pas : votre compte et vos données personnelles sont conservés. Rien n''a été supprimé de votre propre espace.\n\nPour rejoindre à nouveau cet espace, une nouvelle invitation du titulaire sera nécessaire. Si vous n''êtes pas à l''origine de ce départ, contactez notre support en répondant à cet e-mail.\n\nAccéder à mon compte : {{accountUrl}}\n\nVoir mon offre : {{subscriptionUrl}}\n\nCordialement,\nL''équipe Verebona',
       '["firstName","ownerFirstName","accountUrl","subscriptionUrl"]',
       now()
 WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'DUO_MEMBERSHIP_LEFT');
