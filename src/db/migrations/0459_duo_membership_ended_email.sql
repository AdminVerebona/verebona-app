-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0459 : e-mail au membre quand son accès Premium Duo prend fin
-- (lot 64A, décision PO du 16/10/2026).
--
-- Jusqu'ici, la sortie de Duo (titulaire qui retire le second utilisateur,
-- changement d'offre Stripe/BO, rétractation, suppression du compte titulaire)
-- n'informait pas le membre. Un e-mail DUO_MEMBERSHIP_ENDED passe désormais
-- par la file DURABLE des e-mails transactionnels (lot 57A, 0405) :
--
--   1. transactional_email_jobs.kind accepte DUO_MEMBERSHIP_ENDED ;
--   2. transactional_email_jobs.dedupe_key : clé d'idempotence d'un envoi
--      « une fois par événement » (ici : une sortie = un membership × une
--      date d'entrée dans le Duo). Unicité garantie par l'index _idx_1 et,
--      en plus, par un verrou consultatif + NOT EXISTS à l'enregistrement ;
--   3. gabarit DUO_MEMBERSHIP_ENDED créé s'il manque (texte modifiable dans
--      le BO › Communications ; jamais écrasé s'il a été retouché).
--
-- Variables : {{firstName}} (membre), {{ownerFirstName}} (prénom du titulaire,
-- jamais son e-mail), {{accountUrl}}, {{subscriptionUrl}}.
-- Idempotente. Retour arrière : colonne ignorée par l'ancien code ; l'ancien
-- code n'écrit jamais ce type.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE transactional_email_jobs ADD COLUMN IF NOT EXISTS dedupe_key text;

ALTER TABLE transactional_email_jobs DROP CONSTRAINT IF EXISTS transactional_email_jobs_kind_check;
ALTER TABLE transactional_email_jobs ADD CONSTRAINT transactional_email_jobs_kind_check
  CHECK (kind IN ('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED'));

INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
SELECT 'DUO_MEMBERSHIP_ENDED',
       'Votre accès à l''espace Premium Duo a pris fin',
       E'Bonjour {{firstName}},\n\nL''espace Premium Duo que vous partagiez avec {{ownerFirstName}} a pris fin.\n\nCe qui change pour vous : vous n''avez plus accès à l''espace partagé, ni aux biens, documents et échéances qui y sont rattachés. Votre compte revient à votre propre offre (Standard si vous n''avez pas d''abonnement personnel).\n\nCe qui ne change pas : votre compte et vos données personnelles sont conservés. Rien n''a été supprimé de votre propre espace.\n\nAccéder à mon compte : {{accountUrl}}\n\nVoir mon offre : {{subscriptionUrl}}\n\nCordialement,\nL''équipe Verebona',
       '["firstName","ownerFirstName","accountUrl","subscriptionUrl"]',
       now()
 WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'DUO_MEMBERSHIP_ENDED');
