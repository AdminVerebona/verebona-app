-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0620 : e-mail « Invitation Premium Duo refusée » DÉSACTIVÉ PAR
-- DÉFAUT (lot 79C — ticket « E-mails et notifications : supprimer les
-- communications inutiles et fiabiliser les règles d'envoi »).
--
-- Décision PO : la cloche reste obligatoire (statut du panneau d'invitation) ;
-- l'e-mail transactionnel DUO_INVITATION_DECLINED est désactivable et passe
-- désactivé par défaut, réactivable dans BO › Communications (mécanisme
-- existant, COM-011).
--
-- PRÉSERVE LES CHOIX EXPLICITES : une ligne déjà présente dans
-- `communication_channel_settings` est une décision d'un administrateur
-- (activation ou désactivation) — elle n'est jamais modifiée. Seule l'ABSENCE
-- de ligne (valeur automatique « actif ») est remplacée par « inactif » ;
-- elle n'est jamais interprétée comme un consentement. `updated_by` reste NULL
-- (réglage posé par la livraison, pas par une personne).
--
-- Effet sur la file : une demande d'envoi encore en attente est close sans
-- envoi (`cancelled` / CHANNEL_DISABLED, comportement existant du lot 64A),
-- jamais comptée envoyée.
--
-- Idempotente : rejouable sans effet.
-- ──────────────────────────────────────────────────────────────────────────────
INSERT INTO communication_channel_settings (event_code, channel, is_active, updated_by, updated_at)
VALUES ('email:DUO_INVITATION_DECLINED', 'email', false, NULL, now())
ON CONFLICT (event_code, channel) DO NOTHING;
