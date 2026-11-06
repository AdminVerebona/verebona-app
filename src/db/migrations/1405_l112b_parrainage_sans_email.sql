-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1405 : suppression de l'invitation de parrainage PAR E-MAIL
-- (lot 112B, décision PO : « parrainage par e-mail = SUPPRIMER »).
--
-- Depuis le lot 111H, plus rien n'appelait `POST /api/referral/send-email`
-- (Mon compte › Parrainage propose « Partager mon invitation », copie du code,
-- du lien, et un e-mail préparé côté client — `mailto:` — en repli). La route
-- est supprimée du code ; cette migration retire ce qui ne servait qu'à elle :
--
--   1. `referral_email_sends` (compteur des envois acceptés, adresses hachées,
--      migration 0068) : DROP TABLE IF EXISTS. Vérifié avant suppression :
--      aucune clé étrangère, vue, vue matérialisée, fonction ni déclencheur
--      ne dépend de cette table (elle ne faisait que référencer
--      `referral_links` et `accounts`) ;
--   2. le gabarit `REFERRAL_INVITATION` (migrations 0301, 0920) et son
--      historique d'édition (`email_template_versions`) : le BO ne le liste
--      plus (Communications › E-mails transactionnels, éditeur de gabarits).
--      La garde 0483 ignore la suppression d'un gabarit PERSONNALISÉ hors de
--      l'éditeur : la suppression est donc faite sous le réglage de l'éditeur
--      (`verebona.email_template_edit`, local à la transaction du fichier) ;
--   3. le réglage d'activation du canal `email:REFERRAL_INVITATION`
--      (`communication_channel_settings`), s'il avait été posé dans le BO.
--
-- CONSERVÉ : `email_logs` (historique des envois déjà faits, y compris ceux de
-- l'ancienne invitation — libellé « supprimé » dans le BO), `referral_links`,
-- `referral_events`, le gabarit de récompense `REFERRAL_REWARD_GRANTED`, Duo.
--
-- Idempotente et rejouable (IF EXISTS, DELETE ciblés). Le fichier 0301 n'est
-- jamais rejoué par la chaîne (suivi `_migrations`) : le gabarit ne revient pas.
-- Retour arrière : rejouer 0068 (table vide) et 0301 + 0920 (gabarit livré) ;
-- les envois passés ne sont pas reconstituables (table de comptage seulement).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS referral_email_sends;

SELECT set_config('verebona.email_template_edit', 'on', true);

DELETE FROM email_template_versions WHERE upper(template_type) = 'REFERRAL_INVITATION';
DELETE FROM email_templates WHERE upper(type) = 'REFERRAL_INVITATION';
DELETE FROM communication_channel_settings WHERE upper(event_code) = 'EMAIL:REFERRAL_INVITATION';

SELECT set_config('verebona.email_template_edit', '', true);
