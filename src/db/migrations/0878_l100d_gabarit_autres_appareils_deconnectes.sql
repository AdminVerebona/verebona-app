-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0878 : gabarit e-mail « Vos autres appareils ont été déconnectés »
-- (lot 100D — décision PO A2 du 27/10/2026 ; CDC 18 §20.3, §22).
--
-- notif_other_sessions_revoked : e-mail de la notification de sécurité
--   OTHER_SESSIONS_REVOKED (catalogue `lib/notifications/catalog.ts`,
--   OBLIGATOIRE : non désactivable). Envoyé UNE seule fois, uniquement quand
--   « Déconnecter tous les autres appareils » (Mon compte › Sécurité) a
--   réellement révoqué au moins une session
--   (`app/api/users/me/sessions/revoke-others/route.ts`). Jamais pour la
--   déconnexion d'un appareil seul, ni pour une révocation du back-office.
--   Variables fournies par l'application (mécanisme des gabarits `notif_*`,
--   lot 73A) : {{title}}, {{body}} (date et heure, nombre d'appareils,
--   appareil qui a fait la demande — ni IP, ni localisation, ni jeton),
--   {{actionUrl}} (Mon compte › Sécurité › Appareils connectés).
--
-- Texte modifiable dans le BO (Communications) ; idempotente : DO NOTHING
-- pour ne pas écraser un gabarit retouché. Expand seulement.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('notif_other_sessions_revoked',
   'Verebona : vos autres appareils ont été déconnectés',
   E'Bonjour,\n\n{{body}}\n\nVoir mes appareils connectés : {{actionUrl}}\n\nCet e-mail de sécurité confirme une action faite depuis votre compte. Verebona ne vous demandera jamais votre mot de passe par e-mail.\n\nCordialement,\nL''équipe Verebona',
   '["title","body","actionUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
