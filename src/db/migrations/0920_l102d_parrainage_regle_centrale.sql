-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0920 : parrainage — règle centrale unique (lot 102D, décision PO du
-- 30/10/2026 : attribution 90 jours, abonnement annuel, premier paiement
-- encaissé, rétractation expirée, 1 mois offert au parrain, auto-parrainage
-- interdit). Règle : `src/services/referral/referral-rules.ts`.
--
--   · signup_contexts.code_used_at : instant où le lien ou le code a été
--     utilisé (lien /r/<code> signé, sinon saisie à l'inscription). La fenêtre
--     d'attribution est « usage → inscription ≤ 90 jours ». `expires_at` porte
--     désormais la date limite d'inscription de ce lien (usage + 90 jours) ; il
--     ne borne plus la souscription (l'attribution est enregistrée à
--     l'inscription, l'événement de parrainage existe dès ce moment).
--   · Gabarit REFERRAL_INVITATION : la phrase de récompense est complétée par
--     les conditions factuelles et le lien public « Parrainage »
--     ({{referralTermsUrl}} ; {{referralWindowDays}} et {{referralReward}} viennent
--     des paramètres centraux), UNIQUEMENT si le gabarit n'a pas été retouché
--     dans le BO (corps identique à celui de la migration 0301).
--
-- Additive et idempotente. Aucun index (colonne lue par clé utilisateur).
-- Retour arrière : ALTER TABLE signup_contexts DROP COLUMN IF EXISTS code_used_at
-- (le gabarit se rétablit dans le BO).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE signup_contexts ADD COLUMN IF NOT EXISTS code_used_at TIMESTAMPTZ;

UPDATE email_templates
   SET body = E'Bonjour,\n\n<strong>{{senderName}}</strong> vous invite à rejoindre <strong>Verebona</strong>, la plateforme qui simplifie le suivi de votre patrimoine, de vos biens et de vos documents.\n\nCréez votre compte pour découvrir Verebona avec l''essai gratuit. Si vous créez votre compte avec ce lien dans les {{referralWindowDays}} jours puis souscrivez un abonnement annuel, {{senderName}} recevra {{referralReward}} une fois votre premier paiement encaissé et votre délai de rétractation terminé. Vous ne recevez pas d''avantage de parrainage.\n\n{{referralUrl}}\n\nSi le bouton ne fonctionne pas, copiez ce lien dans votre navigateur : {{referralUrl}}\n\nConditions du parrainage : {{referralTermsUrl}}\n\nVous recevez cet e-mail car {{senderName}} a souhaité vous faire découvrir Verebona.',
       placeholders = '["senderName","referralUrl","actionUrl","referralTermsUrl","referralWindowDays","referralReward"]',
       updated_at = NOW()
 WHERE type = 'REFERRAL_INVITATION'
   AND body = E'Bonjour,\n\n<strong>{{senderName}}</strong> vous invite à rejoindre <strong>Verebona</strong>, la plateforme qui simplifie le suivi de votre patrimoine, de vos biens et de vos documents.\n\nCréez votre compte pour découvrir Verebona avec l''essai gratuit. En vous inscrivant via ce lien, {{senderName}} bénéficiera d''un mois offert si vous souscrivez un abonnement annuel.\n\n{{referralUrl}}\n\nSi le bouton ne fonctionne pas, copiez ce lien dans votre navigateur : {{referralUrl}}\n\nVous recevez cet e-mail car {{senderName}} a souhaité vous faire découvrir Verebona.';
