-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0830 : gabarits e-mail du changement d'adresse principale
-- (lot 96A, CDC 18 §11.3, §22, EMAIL-07 ; décision PO Q8).
--
-- EMAIL_CHANGE_CONFIRMATION : lien à usage unique (24 h) envoyé à la NOUVELLE
--   adresse. Variables : {{firstName}}, {{confirmUrl}}, {{expiresIn}}.
-- PRIMARY_EMAIL_CHANGED : notification de sécurité envoyée à l'ANCIENNE et à
--   la NOUVELLE adresse après la bascule. Variables : {{firstName}},
--   {{oldEmail}}, {{newEmail}} (adresses partiellement masquées),
--   {{changeDate}}, {{securityUrl}}, {{forgotPasswordUrl}}.
-- EMAIL_CHANGE_ADDRESS_IN_USE : la nouvelle adresse demandée appartient déjà à
--   un AUTRE compte — aucun changement, aucune fusion ; seul le titulaire de
--   cette boîte l'apprend (réponse identique pour le demandeur). Au plus un
--   par adresse et par heure. Variables : {{firstName}}, {{requestDate}},
--   {{loginUrl}}.
--
-- Non désactivables (sécurité). Textes modifiables dans le BO (Communications).
-- Idempotente : DO NOTHING pour ne pas écraser un gabarit retouché.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('EMAIL_CHANGE_CONFIRMATION',
   'Verebona : confirmez votre nouvelle adresse e-mail',
   E'Bonjour {{firstName}},\n\nVous avez demandé à utiliser cette adresse comme adresse e-mail principale de votre compte Verebona.\n\nPour confirmer, cliquez sur le lien ci-dessous :\n\n{{confirmUrl}}\n\nCe lien est valable {{expiresIn}} et ne fonctionne qu''une fois. Tant que vous ne l''avez pas utilisé, votre adresse actuelle reste celle de votre compte.\n\nSi vous n''êtes pas à l''origine de cette demande, ignorez simplement ce message : rien ne sera modifié.\n\nCordialement,\nL''équipe Verebona',
   '["firstName","confirmUrl","expiresIn"]', NOW()),
  ('PRIMARY_EMAIL_CHANGED',
   'Verebona : l''adresse e-mail de votre compte a été modifiée',
   E'Bonjour {{firstName}},\n\nL''adresse e-mail principale de votre compte Verebona a été modifiée le {{changeDate}}.\n\nAncienne adresse : {{oldEmail}}\nNouvelle adresse : {{newEmail}}\n\nPar sécurité, vos autres appareils ont été déconnectés. Vos biens, documents, partages et votre abonnement sont inchangés.\n\nSi vous êtes à l''origine de ce changement, vous n''avez rien à faire.\n\nSi ce n''est pas vous, réinitialisez tout de suite votre mot de passe puis vérifiez vos appareils connectés :\n\n{{forgotPasswordUrl}}\n\n{{securityUrl}}\n\nCordialement,\nL''équipe Verebona',
   '["firstName","oldEmail","newEmail","changeDate","securityUrl","forgotPasswordUrl"]', NOW()),
  ('EMAIL_CHANGE_ADDRESS_IN_USE',
   'Verebona : votre adresse e-mail a été proposée pour un autre compte',
   E'Bonjour {{firstName}},\n\nLe {{requestDate}}, quelqu''un a demandé à utiliser cette adresse e-mail pour un autre compte Verebona. Elle est déjà celle de votre compte : rien n''a été modifié, aucun compte n''a été fusionné ni transféré.\n\nVous pouvez continuer à vous connecter normalement :\n\n{{loginUrl}}\n\nSi vous n''êtes pas à l''origine de cette demande, vous n''avez rien à faire.\n\nCordialement,\nL''équipe Verebona',
   '["firstName","requestDate","loginUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
