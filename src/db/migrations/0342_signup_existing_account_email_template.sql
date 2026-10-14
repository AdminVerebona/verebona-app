-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0342 : gabarit e-mail SIGNUP_EXISTING_ACCOUNT (lot 53A — retour PO
-- Q21 ; CDC 18 §7.1, §9.1 : inscription non énumérable).
--
-- L'inscription répond désormais de la même façon qu'une adresse soit libre ou
-- déjà inscrite. Quand elle est déjà inscrite, AUCUN compte n'est créé et le
-- propriétaire de la boîte reçoit cet e-mail : lien de connexion, lien « Mot de
-- passe oublié », « ignorez ce message si ce n'était pas vous ».
--
-- Envoi APRÈS la réponse, au plus UN par adresse et par heure (compteur partagé
-- `auth_rate_limits`), sans donnée sensible (ni IP, ni appareil). Expéditeur :
-- celui des réglages e-mail du BO. Texte modifiable dans le BO (Communications).
--
-- Variables : {{firstName}}, {{requestDate}} (date et heure, Europe/Paris),
-- {{loginUrl}}, {{forgotPasswordUrl}}.
-- Idempotente : DO NOTHING pour ne pas écraser un gabarit retouché.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('SIGNUP_EXISTING_ACCOUNT',
   'Verebona : vous avez déjà un compte',
   E'Bonjour {{firstName}},\n\nUne demande de création de compte Verebona a été faite avec votre adresse e-mail le {{requestDate}}.\n\nVous avez déjà un compte Verebona avec cette adresse : aucun nouveau compte n''a été créé et votre compte n''a pas été modifié.\n\nPour vous connecter :\n\n{{loginUrl}}\n\nMot de passe oublié ? Choisissez-en un nouveau ici :\n\n{{forgotPasswordUrl}}\n\nSi vous n''êtes pas à l''origine de cette demande, ignorez simplement ce message.\n\nCordialement,\nL''équipe Verebona',
   '["firstName","requestDate","loginUrl","forgotPasswordUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
