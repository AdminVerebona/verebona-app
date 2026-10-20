-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0527 : rappel d'export dans les e-mails de fin d'accès au Premium Duo
-- (lot 73A, décision PO du 20/10/2026, point 1).
--
-- Parcours réel (lot 72D) : l'export des biens se fait depuis la fiche du bien et
-- n'est proposé au membre qu'AVANT de quitter (« Quitter l'espace ») ; une fois
-- l'accès terminé, il ne voit plus l'espace partagé. Nouveaux textes livrés :
--   · DUO_MEMBERSHIP_ENDED (retrait par le titulaire, fin d'offre…) : le membre
--     ne peut plus exporter lui-même les biens partagés → s'adresser au
--     titulaire ; ses données personnelles restent exportables (Mon compte ›
--     Mes données, {{dataExportUrl}}) ;
--   · DUO_MEMBERSHIP_LEFT (départ volontaire) : export proposé avant le départ ;
--     s'il n'a pas été fait → s'adresser au titulaire ; même rappel « Mes données ».
--
-- GARDE 0483 RESPECTÉE : simple UPDATE, sans le réglage de l'éditeur du BO. Un
-- gabarit PERSONNALISÉ n'est pas écrasé : le déclencheur conserve le texte
-- personnalisé et range le nouveau texte en « texte livré plus récent »
-- (shipped_*, shipped_updated_at), signalé dans le BO (Comparer / Revenir au
-- texte livré). Un gabarit non personnalisé reçoit le nouveau texte, et une
-- version « Texte livré (mise à jour de l'application) » est ajoutée à son
-- historique (nouvelle origine 'shipped_update').
--
-- Idempotente : ne réécrit que si le texte livré connu (shipped_*, à défaut le
-- texte en base) diffère ; rejouée, elle ne change rien (ni date de signalement,
-- ni version en double). Retour arrière : l'ancien code ne fournit pas
-- {{dataExportUrl}} — la variable est alors retirée du rendu (lot 70A) et la
-- ligne « Exporter mes données : » s'affiche sans bouton ; « Revenir au texte
-- livré » d'un gabarit personnalisé reste possible.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- 1. Historique : origine « texte livré par une mise à jour de l'application ».
ALTER TABLE email_template_versions DROP CONSTRAINT IF EXISTS email_template_versions_source_check;
ALTER TABLE email_template_versions ADD CONSTRAINT email_template_versions_source_check
  CHECK (source IN ('initial', 'admin_edit', 'restore', 'reset_shipped', 'shipped_update'));

-- 2. Textes livrés (le déclencheur de la 0483 protège les gabarits personnalisés).
WITH livre(type, subject, body, placeholders) AS (
  VALUES
    ('DUO_MEMBERSHIP_ENDED', $l73a_ended_subject$Votre accès à l'espace Premium Duo a pris fin$l73a_ended_subject$,
     $l73a_ended_body$Bonjour {{firstName}},

L'espace Premium Duo que vous partagiez avec {{ownerFirstName}} a pris fin.

Ce qui change pour vous : vous n'avez plus accès à l'espace partagé, ni aux biens, documents et échéances qui y sont rattachés. Votre compte revient à votre propre offre (Standard si vous n'avez pas d'abonnement personnel).

Ce qui ne change pas : votre compte et vos données personnelles sont conservés. Rien n'a été supprimé de votre propre espace.

Garder une copie : n'ayant plus accès à l'espace partagé, vous ne pouvez plus en exporter les biens vous-même. Si vous souhaitez une copie de certains d'entre eux, adressez-vous, le cas échéant, à {{ownerFirstName}}, qui peut les exporter depuis la fiche de chaque bien. Vos données personnelles restent exportables à tout moment depuis Mon compte, rubrique « Mes données ».

Exporter mes données : {{dataExportUrl}}

Accéder à mon compte : {{accountUrl}}

Voir mon offre : {{subscriptionUrl}}

Cordialement,
L'équipe Verebona$l73a_ended_body$,
     '["firstName","ownerFirstName","accountUrl","subscriptionUrl","dataExportUrl"]'),
    ('DUO_MEMBERSHIP_LEFT', $l73a_left_subject$Vous avez quitté l'espace Premium Duo$l73a_left_subject$,
     $l73a_left_body$Bonjour {{firstName}},

Vous avez quitté l'espace Premium Duo que vous partagiez avec {{ownerFirstName}}. Votre départ a bien été pris en compte.

Ce qui change pour vous : vous n'avez plus accès à l'espace partagé, ni aux biens, documents et échéances qui y sont rattachés. Votre compte revient à votre propre offre (Standard si vous n'avez pas d'abonnement personnel).

Ce qui ne change pas : votre compte et vos données personnelles sont conservés. Rien n'a été supprimé de votre propre espace.

Garder une copie : si vous n'avez pas exporté avant votre départ les biens de l'espace partagé dont vous souhaitiez garder une copie, vous ne pouvez plus le faire vous-même ; adressez-vous à {{ownerFirstName}}, qui peut les exporter depuis la fiche de chaque bien. Vos données personnelles restent exportables à tout moment depuis Mon compte, rubrique « Mes données ».

Pour rejoindre à nouveau cet espace, une nouvelle invitation du titulaire sera nécessaire. Si vous n'êtes pas à l'origine de ce départ, contactez notre support en répondant à cet e-mail.

Exporter mes données : {{dataExportUrl}}

Accéder à mon compte : {{accountUrl}}

Voir mon offre : {{subscriptionUrl}}

Cordialement,
L'équipe Verebona$l73a_left_body$,
     '["firstName","ownerFirstName","accountUrl","subscriptionUrl","dataExportUrl"]')
),
maj AS (
  UPDATE email_templates t
     SET subject = l.subject, body = l.body, placeholders = l.placeholders, updated_at = now()
    FROM livre l
   WHERE upper(t.type) = l.type
     AND (coalesce(t.shipped_body, t.body) IS DISTINCT FROM l.body
          OR coalesce(t.shipped_subject, t.subject) IS DISTINCT FROM l.subject)
  RETURNING upper(t.type) AS type, t.subject, t.body, t.is_customized
)
INSERT INTO email_template_versions (template_type, version_no, subject, body, source, created_at, note)
SELECT m.type,
       coalesce((SELECT max(v.version_no) FROM email_template_versions v WHERE v.template_type = m.type), 0) + 1,
       m.subject, m.body, 'shipped_update', now(),
       'Lot 73 : rappel d''export des données ajouté au texte livré'
  FROM maj m
 WHERE NOT m.is_customized;
