-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1168 : gabarit e-mail « code de vérification » de la récupération
-- d'accès (lot 110B, ticket MFA §5). MFA_RECOVERY_EMAIL_CODE : code à 6
-- chiffres (15 min, 5 essais) prouvant la possession de l'adresse, exigé AVEC
-- un code de récupération. E-mail de sécurité verrouillé (non désactivable).
-- Texte modifiable au BO (Communications) ; idempotente : DO NOTHING pour ne
-- pas écraser un gabarit retouché. Expand seulement.
-- ──────────────────────────────────────────────────────────────────────────────
INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('MFA_RECOVERY_EMAIL_CODE',
   'Verebona : votre code de vérification',
   E'Bonjour {{firstName}},\n\nVous avez demandé à retrouver l''accès à votre compte Verebona avec un code de récupération. Saisissez ce code de vérification :\n\n{{code}}\n\nCe code est valable {{expiresIn}}. Il ne suffit pas à lui seul : un de vos codes de récupération est aussi demandé. Ne le communiquez à personne ; Verebona ne vous le demandera jamais par téléphone ni par e-mail.\n\nSi vous n''êtes pas à l''origine de cette demande, ignorez ce message et vérifiez la sécurité de votre compte.\n\nCordialement,\nL''équipe Verebona',
   '["firstName","code","expiresIn"]', NOW())
ON CONFLICT (type) DO NOTHING;
