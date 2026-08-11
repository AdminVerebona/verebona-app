-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0125 — Quatre gabarits d'email jamais amorcés
--
-- ── COMMENT ILS ONT ÉTÉ TROUVÉS ───────────────────────────────────────────
--
-- Un test compare les codes que le code applicatif DEMANDE à ceux que les
-- migrations et amorçages POSENT. Quatre n'existaient nulle part :
--
--   TRIAL_CONFIRMATION       confirmation d'ouverture d'essai (CDC 1 §6)
--   DOWNGRADE_NOTIFICATION   passage à une offre inférieure
--   DUO_INVITATION           invitation à un compte partagé
--   WITHDRAWAL_VERIFICATION  vérification d'une demande de rétractation (CDC 6)
--
-- Le dernier est le plus sérieux : sans lui, une rétractation ne peut pas
-- être vérifiée, et le §6.2 en fait une étape obligatoire du parcours.
--
-- ── POURQUOI PERSONNE NE L'AVAIT VU ───────────────────────────────────────
--
-- L'envoi échoue en silence, par conception : il ne doit pas faire échouer
-- l'action qui l'a déclenché. L'erreur n'existait que dans `email_logs`, que
-- rien ne consultait.
--
-- ── LES VARIABLES SONT CELLES DU CODE APPELANT ────────────────────────────
--
-- Relevées dans les appels réels, non supposées. Un placeholder absent du
-- gabarit reste non substitué dans le message envoyé.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('TRIAL_CONFIRMATION',
   'Votre essai gratuit Verebona a commencé',
   E'Bonjour {{firstName}},\n\nVotre essai gratuit est ouvert. Il prendra fin le {{trialEndsAt}}.\n\nAucun prélèvement ne sera effectué sans votre accord.\n\nAccéder à Verebona : {{actionUrl}}',
   '["firstName","trialEndsAt","actionUrl"]', NOW()),

  ('DOWNGRADE_NOTIFICATION',
   'Votre offre Verebona a changé',
   E'Bonjour {{firstName}},\n\nVotre compte est passé à une offre inférieure. Vos données sont conservées ; certaines fonctions ne sont plus accessibles.\n\nRevoir mon offre : {{actionUrl}}',
   '["firstName","actionUrl"]', NOW()),

  ('DUO_INVITATION',
   'Vous êtes invité à rejoindre un compte Verebona',
   E'Bonjour,\n\n{{ownerFullName}} vous invite à partager son compte Verebona.\n\nCette invitation expire dans {{expiresIn}}.\n\nAccepter : {{actionUrl}}',
   '["ownerFirstName","ownerLastName","ownerFullName","expiresIn","actionUrl"]', NOW()),

  -- ⚠️ Étape obligatoire du parcours de rétractation (CDC 6 §6.2). Sans ce
  -- gabarit, la demande ne peut pas être vérifiée et reste bloquée.
  ('WITHDRAWAL_VERIFICATION',
   'Confirmez votre demande de rétractation',
   E'Bonjour {{firstName}},\n\nPour confirmer votre demande de rétractation, cliquez sur le lien ci-dessous.\n\n{{verificationUrl}}\n\nSi vous n''êtes pas à l''origine de cette demande, ignorez ce message ou écrivez-nous : {{contactEmail}}',
   '["firstName","verificationUrl","contactEmail"]', NOW())

-- Rejouable : `type` porte un index unique. `DO UPDATE` pour qu'une
-- correction de libellé se propage au déploiement suivant.
ON CONFLICT (type) DO UPDATE
  SET subject = EXCLUDED.subject,
      body = EXCLUDED.body,
      placeholders = EXCLUDED.placeholders,
      updated_at = NOW();
