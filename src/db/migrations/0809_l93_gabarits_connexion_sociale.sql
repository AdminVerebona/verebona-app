-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0809 : gabarits e-mail de la connexion Google / Apple (lot 93 —
-- CDC 18 §10.4, §6, §37).
--
-- PASSWORD_RESET_SOCIAL_ONLY : réponse à « Mot de passe oublié » pour un compte
--   SANS mot de passe (créé avec Google ou Apple). Aucun mot de passe n'est créé
--   (PWD-07) ; l'e-mail indique de se connecter avec le fournisseur, puis
--   d'ajouter un mot de passe depuis Mon compte › Sécurité si souhaité.
--   Variables : {{firstName}}, {{providers}} (« Google », « Apple » ou
--   « Google ou Apple »), {{loginUrl}}.
-- SOCIAL_SIGNUP_EMAIL_CODE : code à 6 chiffres (15 min, 5 essais) quand
--   l'adresse principale choisie à l'inscription Google / Apple diffère de
--   celle attestée par le fournisseur (ou qu'il n'en a transmis aucune).
--   Variables : {{firstName}}, {{code}}, {{expiresIn}}. Le code est
--   masqué dans le journal des e-mails.
--
-- Non désactivables (sécurité). Textes modifiables dans le BO (Communications).
-- Idempotente : DO NOTHING pour ne pas écraser un gabarit retouché.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('PASSWORD_RESET_SOCIAL_ONLY',
   'Verebona : connectez-vous avec {{providers}}',
   E'Bonjour {{firstName}},\n\nVous avez demandé à réinitialiser le mot de passe de votre compte Verebona. Votre compte n''a pas de mot de passe : vous vous connectez avec {{providers}}. Aucun mot de passe n''a été créé ni modifié.\n\nPour vous connecter, choisissez « Continuer avec {{providers}} » :\n\n{{loginUrl}}\n\nVous souhaitez aussi un mot de passe ? Connectez-vous avec {{providers}}, puis ouvrez Mon compte › Sécurité et choisissez « Ajouter un mot de passe ».\n\nSi vous n''êtes pas à l''origine de cette demande, ignorez simplement ce message.\n\nCordialement,\nL''équipe Verebona',
   '["firstName","providers","loginUrl"]', NOW()),
  ('SOCIAL_SIGNUP_EMAIL_CODE',
   'Verebona : votre code de confirmation',
   E'Bonjour {{firstName}},\n\nPour terminer la création de votre compte Verebona, saisissez ce code de confirmation :\n\n{{code}}\n\nCe code est valable {{expiresIn}}. Ne le communiquez à personne.\n\nSi vous n''êtes pas à l''origine de cette demande, ignorez simplement ce message : aucun compte ne sera créé.\n\nCordialement,\nL''équipe Verebona',
   '["firstName","code","expiresIn"]', NOW())
ON CONFLICT (type) DO NOTHING;
