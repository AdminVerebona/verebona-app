-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0314 : gabarit e-mail SECURITY_SESSIONS_REVOKED (lot 38, volet B —
-- suite du lot 37, C2 ; CDC 18 §19.3).
--
-- Envoyé quand un jeton de renouvellement DÉJÀ TOURNÉ est présenté au-delà de
-- la fenêtre de grâce : toutes les sessions de l'utilisateur viennent d'être
-- révoquées (journal AUTH_TOKEN_REUSE_DETECTED). L'e-mail invite à se
-- reconnecter et, si ce n'était pas l'utilisateur, à changer son mot de passe
-- (lien « Mot de passe oublié »).
--
-- Envoi APRÈS la réponse (aucun ralentissement du renouvellement), au plus UN
-- par utilisateur et par heure (compteur partagé `auth_rate_limits`), sans
-- aucune donnée sensible (ni IP, ni appareil, ni jeton). Expéditeur : celui
-- des réglages e-mail du BO. Texte modifiable dans le BO (Communications) ;
-- désactivable comme tout e-mail transactionnel.
--
-- Variables : {{firstName}}, {{incidentDate}} (date et heure, Europe/Paris),
-- {{loginUrl}}, {{forgotPasswordUrl}}.
-- Idempotente : DO NOTHING pour ne pas écraser un gabarit retouché.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('SECURITY_SESSIONS_REVOKED',
   'Verebona : vos appareils ont été déconnectés par précaution',
   E'Bonjour {{firstName}},\n\nPar précaution, nous avons déconnecté vos appareils de votre compte Verebona le {{incidentDate}} : une ancienne session a tenté de se reconnecter alors qu''elle avait déjà été renouvelée.\n\nPour continuer à utiliser Verebona, reconnectez-vous simplement :\n\n{{loginUrl}}\n\nSi ce n''était pas vous, ou en cas de doute, changez votre mot de passe dès maintenant avec « Mot de passe oublié » :\n\n{{forgotPasswordUrl}}\n\nCordialement,\nL''équipe Verebona',
   '["firstName","incidentDate","loginUrl","forgotPasswordUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
