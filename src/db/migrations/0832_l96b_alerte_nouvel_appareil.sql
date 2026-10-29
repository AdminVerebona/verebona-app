-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0832 : gabarit e-mail « Connexion depuis un nouvel appareil »
-- (lot 96B — CDC 18 §20.4, §22, SESS-11 ; décision PO Q6).
--
-- notif_new_device_login : e-mail de la notification de sécurité
--   NEW_DEVICE_LOGIN (catalogue `lib/notifications/catalog.ts`, OBLIGATOIRE :
--   non désactivable par l'utilisateur ni par le BO). Envoyé une seule fois,
--   à la première connexion réussie (mot de passe, Google, Apple, activation)
--   depuis un appareil inconnu pour ce compte (`lib/auth/new-device-alert.ts`).
--   Variables fournies par l'application (mécanisme des gabarits `notif_*`,
--   lot 73A) : {{title}}, {{body}} (date et heure, appareil et navigateur ou
--   application — ni IP ni localisation), {{actionUrl}} (Mon compte ›
--   Sécurité › Appareils connectés).
--
-- Texte modifiable dans le BO (Communications) ; idempotente : DO NOTHING
-- pour ne pas écraser un gabarit retouché. Expand seulement.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('notif_new_device_login',
   'Verebona : connexion depuis un nouvel appareil',
   E'Bonjour,\n\n{{body}}\n\nVoir mes appareils connectés : {{actionUrl}}\n\nCet e-mail de sécurité est envoyé une seule fois par nouvel appareil. Verebona ne vous demandera jamais votre mot de passe par e-mail.\n\nCordialement,\nL''équipe Verebona',
   '["title","body","actionUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
