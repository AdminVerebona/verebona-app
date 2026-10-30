-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0887 : modèles de la séquence de fin d'essai (lot 100G ; décision
-- PO « Questions PO (3) », E1 — textes repris MOT POUR MOT ; E2).
--
--   · J−2 et J0 : les gabarits RÉELLEMENT expédiés des événements
--     TRIAL_ENDING / TRIAL_ENDED (`notif_trial_ending`, `notif_trial_ended`),
--     modifiables dans le BO, reçoivent les textes E1 et leurs variables
--     ({{firstName}}, {{trialEndsAt}}, {{offersUrl}}) : UN SEUL circuit (E2).
--   · J+3, J+10, J+30, J+60 (campagne commerciale, désinscription
--     {{unsubscribeUrl}}) et J+80 (créé, envoi verrouillé côté serveur).
--   · Aucun nom ni adresse d'expéditeur, aucune signature, aucun champ « De ».
--
-- GARDE 0483 RESPECTÉE : un gabarit PERSONNALISÉ n'est pas écrasé (le nouveau
-- texte devient « texte livré plus récent », signalé dans le BO). Version
-- « Texte livré (mise à jour de l'application) » ajoutée à l'historique d'un
-- gabarit non personnalisé ou créé.
--
-- MENTIONS OBSOLÈTES (E2) : un modèle d'essai (confirmation, rappels, fin
-- d'essai) qui annonce encore un essai de 60 jours, « 2 mois offerts » ou un
-- passage automatique à 59 € est CORRIGÉ, personnalisé ou non (information
-- fausse) — version tracée avec son motif.
--
-- Idempotente : rejouée, elle ne change rien (textes identiques, aucune
-- version en double). Retour arrière : l'ancien code envoie ces gabarits avec
-- {{title}} / {{body}} / {{actionUrl}} — absents des nouveaux textes, ils sont
-- ignorés (lot 70A) ; « Restaurer » une version précédente reste possible.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- 1. Textes livrés E1 (création ou mise à jour, garde des gabarits personnalisés).
WITH livre(type, subject, body, placeholders) AS (
  VALUES
    ('notif_trial_ending',
     $l100g_s0$Votre essai gratuit Verebona se termine bientôt$l100g_s0$,
     $l100g_b0$Bonjour {{firstName}},

Votre essai gratuit Verebona se termine dans deux jours.

Vous pouvez encore profiter des fonctionnalités de votre essai jusqu’au {{trialEndsAt}}.

À l’expiration, vous pourrez consulter et exporter les informations de votre espace, mais les ajouts et modifications seront suspendus jusqu’à la souscription d’un abonnement.

Découvrir les offres Verebona : {{offersUrl}}

Aucun prélèvement automatique n’aura lieu à la fin de votre essai.$l100g_b0$,
     '["firstName","trialEndsAt","offersUrl"]'),
    ('notif_trial_ended',
     $l100g_s1$Votre essai gratuit Verebona est terminé$l100g_s1$,
     $l100g_b1$Bonjour {{firstName}},

Votre période d’essai gratuite de 7 jours vient de se terminer.

Vos données sont conservées. Vous pouvez toujours consulter vos biens, équipements, documents et échéances dans Verebona.

Pour reprendre l’ajout et la modification d’informations, ainsi que les fonctionnalités correspondant à votre offre, il vous suffit de souscrire un abonnement depuis notre site Web.

Découvrir les offres et souscrire : {{offersUrl}}

Aucun prélèvement automatique n’a été effectué à la fin de votre essai.$l100g_b1$,
     '["firstName","offersUrl"]'),
    ('TRIAL_FOLLOWUP_J3',
     $l100g_s2$Continuez à profiter pleinement de Verebona$l100g_s2$,
     $l100g_b2$Bonjour {{firstName}},

Vous avez découvert Verebona pendant votre essai gratuit.

Pour continuer à profiter pleinement des fonctionnalités de Verebona, choisissez l’abonnement qui correspond à vos besoins.

Vous pourrez ainsi reprendre l’ajout de vos documents, enrichir vos dossiers et retrouver les fonctionnalités disponibles dans votre offre. Les fonctionnalités avancées découvertes pendant l’essai sont accessibles avec Premium ou Premium Duo.

Toutes les données que vous avez déjà enregistrées sont conservées : vous n’avez rien à recommencer.

Choisir mon abonnement sur le site Verebona : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}$l100g_b2$,
     '["firstName","offersUrl","unsubscribeUrl"]'),
    ('TRIAL_FOLLOWUP_J10',
     $l100g_s3$Vos documents sont déjà réunis. Continuez à en profiter.$l100g_s3$,
     $l100g_b3$Bonjour {{firstName}},

Vous avez commencé à organiser vos biens et vos documents dans Verebona.

L’intérêt de cette organisation se construit dans la durée : conserver les factures, retrouver les garanties, suivre les échéances et disposer d’un dossier à jour lorsque vous en avez besoin.

Vos informations restent disponibles en consultation.

Si vous souhaitez poursuivre cette organisation, découvrez les différentes offres Verebona.

Voir les offres : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}$l100g_b3$,
     '["firstName","offersUrl","unsubscribeUrl"]'),
    ('TRIAL_FOLLOWUP_J30',
     $l100g_s4$Un document retrouvé au bon moment peut tout changer$l100g_s4$,
     $l100g_b4$Bonjour {{firstName}},

Une facture à retrouver, une garantie à vérifier, un document à transmettre ou une échéance à anticiper : ces situations arrivent souvent lorsqu’on ne s’y attend pas.

Verebona vous aide à conserver et organiser les informations utiles sur vos biens, pour les retrouver plus facilement lorsque vous en avez besoin.

Votre espace existe toujours. Vous pouvez reprendre son utilisation en choisissant l’abonnement adapté à vos besoins.

Découvrir les abonnements : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}$l100g_b4$,
     '["firstName","offersUrl","unsubscribeUrl"]'),
    ('TRIAL_FOLLOWUP_J60',
     $l100g_s5$Votre espace Verebona reste disponible$l100g_s5$,
     $l100g_b5$Bonjour {{firstName}},

Votre période d’essai Verebona s’est terminée il y a quelque temps.

Nous souhaitions simplement vous rappeler que vos informations restent disponibles en consultation et que vous pouvez reprendre l’utilisation du service en activant un abonnement.

Les offres Standard, Premium et Premium Duo permettent de choisir le niveau de service correspondant à vos besoins.

Consulter les offres Verebona : {{offersUrl}}

Il s’agit de notre dernière relance dans le cadre de votre essai gratuit.

Ne plus recevoir de communications commerciales : {{unsubscribeUrl}}$l100g_b5$,
     '["firstName","offersUrl","unsubscribeUrl"]'),
    ('TRIAL_DATA_RETENTION_J80',
     $l100g_s6$Vos données Verebona : encore {{daysRemaining}} jours pour les récupérer$l100g_s6$,
     $l100g_b6$Bonjour {{firstName}},

Votre période d’essai Verebona est terminée, mais vos informations sont toujours disponibles en consultation.

Il vous reste {{daysRemaining}} jours, soit jusqu’au {{dataDeletionDate}}, pour retrouver et exporter vos données.

Passé cette date, en l’absence de souscription, votre compte et ses données seront supprimés conformément aux conditions de conservation applicables.

Vous pouvez soit reprendre l’utilisation de Verebona en choisissant un abonnement, soit récupérer vos informations en les exportant avant cette échéance.

Découvrir les offres et souscrire : {{offersUrl}}

Exporter mes données : {{exportUrl}}

Ne plus recevoir de communications commerciales : {{unsubscribeUrl}}$l100g_b6$,
     '["firstName","daysRemaining","dataDeletionDate","offersUrl","exportUrl","unsubscribeUrl"]')
),
maj AS (
  UPDATE email_templates t
     SET subject = l.subject, body = l.body, placeholders = l.placeholders, updated_at = now()
    FROM livre l
   WHERE upper(t.type) = upper(l.type)
     AND (coalesce(t.shipped_body, t.body) IS DISTINCT FROM l.body
          OR coalesce(t.shipped_subject, t.subject) IS DISTINCT FROM l.subject)
  RETURNING upper(t.type) AS type, t.subject, t.body, t.is_customized
),
cree AS (
  INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
  SELECT l.type, l.subject, l.body, l.placeholders, now()
    FROM livre l
   WHERE NOT EXISTS (SELECT 1 FROM email_templates t WHERE upper(t.type) = upper(l.type))
  RETURNING upper(type) AS type, subject, body, is_customized
)
INSERT INTO email_template_versions (template_type, version_no, subject, body, source, created_at, note)
SELECT x.type,
       coalesce((SELECT max(v.version_no) FROM email_template_versions v WHERE v.template_type = x.type), 0) + 1,
       x.subject, x.body, 'shipped_update', now(),
       'Lot 100G : séquence de fin d''essai — texte livré (décision PO E1, essai de 7 jours sans prélèvement)'
  FROM (SELECT * FROM maj UNION ALL SELECT * FROM cree) x
 WHERE NOT x.is_customized;

-- 2. Mentions obsolètes (60 jours, 2 mois offerts, 59 €) dans les modèles d'essai :
--    corrigées même si le gabarit a été personnalisé (information fausse).
SELECT set_config('verebona.email_template_edit', 'on', true);

WITH correction(type, subject, body) AS (
  VALUES
    ('TRIAL_CONFIRMATION',
     $l100g_cs$Votre essai gratuit Verebona a commencé$l100g_cs$,
     $l100g_cb$Bonjour {{firstName}},

Votre essai gratuit de 7 jours est ouvert. Il prendra fin le {{trialEndsAt}}.

Aucune carte bancaire n’est demandée et aucun prélèvement automatique n’aura lieu à la fin de votre essai.

Accéder à Verebona : {{actionUrl}}$l100g_cb$)
),
cible AS (
  SELECT t.id, upper(t.type) AS type,
         coalesce(c.subject, l.subject) AS subject, coalesce(c.body, l.body) AS body
    FROM email_templates t
    LEFT JOIN correction c ON upper(t.type) = c.type
    LEFT JOIN (VALUES
    ('notif_trial_ending',
     $l100g_s0$Votre essai gratuit Verebona se termine bientôt$l100g_s0$,
     $l100g_b0$Bonjour {{firstName}},

Votre essai gratuit Verebona se termine dans deux jours.

Vous pouvez encore profiter des fonctionnalités de votre essai jusqu’au {{trialEndsAt}}.

À l’expiration, vous pourrez consulter et exporter les informations de votre espace, mais les ajouts et modifications seront suspendus jusqu’à la souscription d’un abonnement.

Découvrir les offres Verebona : {{offersUrl}}

Aucun prélèvement automatique n’aura lieu à la fin de votre essai.$l100g_b0$,
     '["firstName","trialEndsAt","offersUrl"]'),
    ('notif_trial_ended',
     $l100g_s1$Votre essai gratuit Verebona est terminé$l100g_s1$,
     $l100g_b1$Bonjour {{firstName}},

Votre période d’essai gratuite de 7 jours vient de se terminer.

Vos données sont conservées. Vous pouvez toujours consulter vos biens, équipements, documents et échéances dans Verebona.

Pour reprendre l’ajout et la modification d’informations, ainsi que les fonctionnalités correspondant à votre offre, il vous suffit de souscrire un abonnement depuis notre site Web.

Découvrir les offres et souscrire : {{offersUrl}}

Aucun prélèvement automatique n’a été effectué à la fin de votre essai.$l100g_b1$,
     '["firstName","offersUrl"]'),
    ('TRIAL_FOLLOWUP_J3',
     $l100g_s2$Continuez à profiter pleinement de Verebona$l100g_s2$,
     $l100g_b2$Bonjour {{firstName}},

Vous avez découvert Verebona pendant votre essai gratuit.

Pour continuer à profiter pleinement des fonctionnalités de Verebona, choisissez l’abonnement qui correspond à vos besoins.

Vous pourrez ainsi reprendre l’ajout de vos documents, enrichir vos dossiers et retrouver les fonctionnalités disponibles dans votre offre. Les fonctionnalités avancées découvertes pendant l’essai sont accessibles avec Premium ou Premium Duo.

Toutes les données que vous avez déjà enregistrées sont conservées : vous n’avez rien à recommencer.

Choisir mon abonnement sur le site Verebona : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}$l100g_b2$,
     '["firstName","offersUrl","unsubscribeUrl"]'),
    ('TRIAL_FOLLOWUP_J10',
     $l100g_s3$Vos documents sont déjà réunis. Continuez à en profiter.$l100g_s3$,
     $l100g_b3$Bonjour {{firstName}},

Vous avez commencé à organiser vos biens et vos documents dans Verebona.

L’intérêt de cette organisation se construit dans la durée : conserver les factures, retrouver les garanties, suivre les échéances et disposer d’un dossier à jour lorsque vous en avez besoin.

Vos informations restent disponibles en consultation.

Si vous souhaitez poursuivre cette organisation, découvrez les différentes offres Verebona.

Voir les offres : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}$l100g_b3$,
     '["firstName","offersUrl","unsubscribeUrl"]'),
    ('TRIAL_FOLLOWUP_J30',
     $l100g_s4$Un document retrouvé au bon moment peut tout changer$l100g_s4$,
     $l100g_b4$Bonjour {{firstName}},

Une facture à retrouver, une garantie à vérifier, un document à transmettre ou une échéance à anticiper : ces situations arrivent souvent lorsqu’on ne s’y attend pas.

Verebona vous aide à conserver et organiser les informations utiles sur vos biens, pour les retrouver plus facilement lorsque vous en avez besoin.

Votre espace existe toujours. Vous pouvez reprendre son utilisation en choisissant l’abonnement adapté à vos besoins.

Découvrir les abonnements : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}$l100g_b4$,
     '["firstName","offersUrl","unsubscribeUrl"]'),
    ('TRIAL_FOLLOWUP_J60',
     $l100g_s5$Votre espace Verebona reste disponible$l100g_s5$,
     $l100g_b5$Bonjour {{firstName}},

Votre période d’essai Verebona s’est terminée il y a quelque temps.

Nous souhaitions simplement vous rappeler que vos informations restent disponibles en consultation et que vous pouvez reprendre l’utilisation du service en activant un abonnement.

Les offres Standard, Premium et Premium Duo permettent de choisir le niveau de service correspondant à vos besoins.

Consulter les offres Verebona : {{offersUrl}}

Il s’agit de notre dernière relance dans le cadre de votre essai gratuit.

Ne plus recevoir de communications commerciales : {{unsubscribeUrl}}$l100g_b5$,
     '["firstName","offersUrl","unsubscribeUrl"]'),
    ('TRIAL_DATA_RETENTION_J80',
     $l100g_s6$Vos données Verebona : encore {{daysRemaining}} jours pour les récupérer$l100g_s6$,
     $l100g_b6$Bonjour {{firstName}},

Votre période d’essai Verebona est terminée, mais vos informations sont toujours disponibles en consultation.

Il vous reste {{daysRemaining}} jours, soit jusqu’au {{dataDeletionDate}}, pour retrouver et exporter vos données.

Passé cette date, en l’absence de souscription, votre compte et ses données seront supprimés conformément aux conditions de conservation applicables.

Vous pouvez soit reprendre l’utilisation de Verebona en choisissant un abonnement, soit récupérer vos informations en les exportant avant cette échéance.

Découvrir les offres et souscrire : {{offersUrl}}

Exporter mes données : {{exportUrl}}

Ne plus recevoir de communications commerciales : {{unsubscribeUrl}}$l100g_b6$,
     '["firstName","daysRemaining","dataDeletionDate","offersUrl","exportUrl","unsubscribeUrl"]')
    ) AS l(type, subject, body, placeholders) ON upper(t.type) = upper(l.type)
   WHERE upper(t.type) IN ('TRIAL_CONFIRMATION', 'TRIAL_REMINDER_J3', 'TRIAL_REMINDER_J1', 'TRIAL_ENDED',
                           'NOTIF_TRIAL_ENDING', 'NOTIF_TRIAL_ENDED', 'TRIAL_FOLLOWUP_J3', 'TRIAL_FOLLOWUP_J10',
                           'TRIAL_FOLLOWUP_J30', 'TRIAL_FOLLOWUP_J60', 'TRIAL_DATA_RETENTION_J80')
     AND (t.subject || ' ' || t.body) ~* '(\m60\s*(jours|days)\M|\m59\s*(€|&euro;|euros?)|\m(2|deux)\s*mois\s*(offerts|gratuits)|essai\s+de\s+60)'
),
-- Modèles retirés de l'envoi (TRIAL_REMINDER_J3 / J1, TRIAL_ENDED) : texte neutre.
corrige AS (
  UPDATE email_templates t
     SET subject = coalesce(c.subject, 'Modèle retiré'),
         body = coalesce(c.body, 'Modèle retiré (lot 100G) : remplacé par la séquence de fin d’essai (notif_trial_ending, notif_trial_ended).'),
         is_customized = false, customized_at = NULL,
         shipped_subject = coalesce(c.subject, 'Modèle retiré'),
         shipped_body = coalesce(c.body, 'Modèle retiré (lot 100G) : remplacé par la séquence de fin d’essai (notif_trial_ending, notif_trial_ended).'),
         shipped_updated_at = NULL, updated_at = now()
    FROM cible c
   WHERE t.id = c.id
  RETURNING upper(t.type) AS type, t.subject, t.body
)
INSERT INTO email_template_versions (template_type, version_no, subject, body, source, created_at, note)
SELECT x.type,
       coalesce((SELECT max(v.version_no) FROM email_template_versions v WHERE v.template_type = x.type), 0) + 1,
       x.subject, x.body, 'shipped_update', now(),
       'Lot 100G : mention obsolète corrigée (essai de 60 jours / 2 mois offerts / 59 €) — l''essai dure 7 jours, sans prélèvement'
  FROM corrige x;

SELECT set_config('verebona.email_template_edit', 'off', true);
