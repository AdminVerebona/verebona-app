-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0308 : gabarit e-mail PRICE_CHANGE_NOTICE — information préalable
-- d'une revalorisation (lot 35C, CDC lookup_key V4, §1.3, LK-108, EX-029).
--
-- Envoyé UNIQUEMENT depuis le BO (Exploitation › Catalogue Stripe,
-- « Informer par e-mail »), après saisie d'une référence de validation
-- juridique du texte : le code n'envoie jamais cette information de lui-même
-- et ne la considère jamais envoyée sans preuve (réponse du service d'envoi).
-- TEXTE À FAIRE VALIDER PAR LE CONSEIL JURIDIQUE avant tout envoi ; il est
-- modifiable dans le BO (Communications).
--
-- Variables : {{firstName}}, {{planLabel}}, {{oldAmount}}, {{newAmount}},
-- {{effectiveFrom}} (date à partir de laquelle la revalorisation peut
-- s'appliquer — en pratique au premier renouvellement suivant).
-- Idempotente : DO NOTHING pour ne pas écraser un gabarit retouché.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('PRICE_CHANGE_NOTICE',
   'Évolution du tarif de votre abonnement Verebona {{planLabel}}',
   E'Bonjour {{firstName}},\n\nNous vous informons de l''évolution du tarif de votre abonnement <strong>Verebona {{planLabel}}</strong>.\n\nTarif actuel : <strong>{{oldAmount}}</strong>\nNouveau tarif : <strong>{{newAmount}}</strong>\n\nLe nouveau tarif s''appliquera au plus tôt à votre premier renouvellement à compter du {{effectiveFrom}}. La période déjà réglée n''est pas modifiée.\n\nVous pouvez résilier votre abonnement à tout moment depuis votre compte avant cette échéance ; la résiliation prend effet à la fin de la période en cours.\n\nL''équipe Verebona',
   '["firstName","planLabel","oldAmount","newAmount","effectiveFrom"]', NOW())
ON CONFLICT (type) DO NOTHING;
