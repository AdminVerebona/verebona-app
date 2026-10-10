-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0301 : gabarit e-mail REFERRAL_INVITATION (lot 34I, « mail
-- parrainage KO »).
--
-- L'invitation de parrainage (Mon compte › Parrainage) était envoyée par un
-- appel direct au SDK Resend, avec un expéditeur codé en dur et un corps HTML
-- dans le code. Elle passe désormais par le service e-mail commun, qui lit
-- son gabarit ici : objet et corps modifiables dans le BO (Communications),
-- même expéditeur que les autres e-mails (`email_settings`).
--
-- Variables (relevées dans `sendReferralInvitations`) :
--   {{senderName}}   prénom et nom du parrain (balisage retiré) ;
--   {{referralUrl}}  lien de parrainage <app>/r/<CODE> ;
--   {{actionUrl}}    identique à referralUrl (convention des gabarits).
-- Une ligne réduite à une URL est rendue en bouton par le service e-mail.
--
-- L'avantage revient au PARRAIN (un mois offert si le filleul souscrit un
-- abonnement annuel) : rien n'est promis au destinataire.
--
-- Idempotente : `type` est unique ; DO NOTHING pour ne pas écraser un gabarit
-- déjà retouché dans le BO.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('REFERRAL_INVITATION',
   '{{senderName}} vous invite à découvrir Verebona',
   E'Bonjour,\n\n<strong>{{senderName}}</strong> vous invite à rejoindre <strong>Verebona</strong>, la plateforme qui simplifie le suivi de votre patrimoine, de vos biens et de vos documents.\n\nCréez votre compte pour découvrir Verebona avec l''essai gratuit. En vous inscrivant via ce lien, {{senderName}} bénéficiera d''un mois offert si vous souscrivez un abonnement annuel.\n\n{{referralUrl}}\n\nSi le bouton ne fonctionne pas, copiez ce lien dans votre navigateur : {{referralUrl}}\n\nVous recevez cet e-mail car {{senderName}} a souhaité vous faire découvrir Verebona.',
   '["senderName","referralUrl","actionUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
