/**
 * Lot 100G — modèles d'e-mails de la séquence de fin d'essai (décision PO
 * « Questions PO (3) », section E1, du 27/10/2026), REPRIS MOT POUR MOT.
 *
 * Source unique des textes livrés : la migration 0887 (contenu en base),
 * l'amorçage `email_templates_trial.ts` et les tests (contrôle à l'identique,
 * `__tests__/l100g-fin-essai.test.ts`).
 *
 * RÈGLE ABSOLUE (E) : aucun nom ni adresse d'expéditeur, aucune signature,
 * aucun champ « De » dans les modèles. L'expéditeur technique reste celui des
 * réglages e-mail du BO (enveloppe), hors modèle.
 *
 * Format « texte » : paragraphes séparés par une ligne vide ; une ligne
 * « Libellé : {{lien}} » devient un bouton à la charte (enveloppe du code),
 * sauf « Ne plus recevoir… » rendu en lien discret.
 *
 * Un seul circuit (E2) : J−2 et J0 sont les gabarits RÉELLEMENT expédiés des
 * événements TRIAL_ENDING / TRIAL_ENDED (`notif_trial_ending`,
 * `notif_trial_ended`), modifiables dans le BO ; plus aucun autre modèle
 * d'essai n'est envoyé (TRIAL_REMINDER_J3, TRIAL_REMINDER_J1, TRIAL_ENDED :
 * retirés, `RETIRED_TRANSACTIONAL_EMAILS`).
 */

export interface ShippedTrialTemplate {
  /** Type en base (`email_templates.type`) — casse d'origine conservée. */
  type: string;
  subject: string;
  body: string;
  placeholders: string[];
}

export const TRIAL_TEMPLATE_J_MINUS_2: ShippedTrialTemplate = {
  type: 'notif_trial_ending',
  subject: 'Votre essai gratuit Verebona se termine bientôt',
  body: `Bonjour {{firstName}},

Votre essai gratuit Verebona se termine dans deux jours.

Vous pouvez encore profiter des fonctionnalités de votre essai jusqu’au {{trialEndsAt}}.

À l’expiration, vous pourrez consulter et exporter les informations de votre espace, mais les ajouts et modifications seront suspendus jusqu’à la souscription d’un abonnement.

Découvrir les offres Verebona : {{offersUrl}}

Aucun prélèvement automatique n’aura lieu à la fin de votre essai.`,
  placeholders: ['firstName', 'trialEndsAt', 'offersUrl'],
};

export const TRIAL_TEMPLATE_J0: ShippedTrialTemplate = {
  type: 'notif_trial_ended',
  subject: 'Votre essai gratuit Verebona est terminé',
  body: `Bonjour {{firstName}},

Votre période d’essai gratuite de 7 jours vient de se terminer.

Vos données sont conservées. Vous pouvez toujours consulter vos biens, équipements, documents et échéances dans Verebona.

Pour reprendre l’ajout et la modification d’informations, ainsi que les fonctionnalités correspondant à votre offre, il vous suffit de souscrire un abonnement depuis notre site Web.

Découvrir les offres et souscrire : {{offersUrl}}

Aucun prélèvement automatique n’a été effectué à la fin de votre essai.`,
  placeholders: ['firstName', 'offersUrl'],
};

export const TRIAL_TEMPLATE_J3: ShippedTrialTemplate = {
  type: 'TRIAL_FOLLOWUP_J3',
  subject: 'Continuez à profiter pleinement de Verebona',
  body: `Bonjour {{firstName}},

Vous avez découvert Verebona pendant votre essai gratuit.

Pour continuer à profiter pleinement des fonctionnalités de Verebona, choisissez l’abonnement qui correspond à vos besoins.

Vous pourrez ainsi reprendre l’ajout de vos documents, enrichir vos dossiers et retrouver les fonctionnalités disponibles dans votre offre. Les fonctionnalités avancées découvertes pendant l’essai sont accessibles avec Premium ou Premium Duo.

Toutes les données que vous avez déjà enregistrées sont conservées : vous n’avez rien à recommencer.

Choisir mon abonnement sur le site Verebona : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}`,
  placeholders: ['firstName', 'offersUrl', 'unsubscribeUrl'],
};

export const TRIAL_TEMPLATE_J10: ShippedTrialTemplate = {
  type: 'TRIAL_FOLLOWUP_J10',
  subject: 'Vos documents sont déjà réunis. Continuez à en profiter.',
  body: `Bonjour {{firstName}},

Vous avez commencé à organiser vos biens et vos documents dans Verebona.

L’intérêt de cette organisation se construit dans la durée : conserver les factures, retrouver les garanties, suivre les échéances et disposer d’un dossier à jour lorsque vous en avez besoin.

Vos informations restent disponibles en consultation.

Si vous souhaitez poursuivre cette organisation, découvrez les différentes offres Verebona.

Voir les offres : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}`,
  placeholders: ['firstName', 'offersUrl', 'unsubscribeUrl'],
};

export const TRIAL_TEMPLATE_J30: ShippedTrialTemplate = {
  type: 'TRIAL_FOLLOWUP_J30',
  subject: 'Un document retrouvé au bon moment peut tout changer',
  body: `Bonjour {{firstName}},

Une facture à retrouver, une garantie à vérifier, un document à transmettre ou une échéance à anticiper : ces situations arrivent souvent lorsqu’on ne s’y attend pas.

Verebona vous aide à conserver et organiser les informations utiles sur vos biens, pour les retrouver plus facilement lorsque vous en avez besoin.

Votre espace existe toujours. Vous pouvez reprendre son utilisation en choisissant l’abonnement adapté à vos besoins.

Découvrir les abonnements : {{offersUrl}}

Ne plus recevoir ces relances : {{unsubscribeUrl}}`,
  placeholders: ['firstName', 'offersUrl', 'unsubscribeUrl'],
};

export const TRIAL_TEMPLATE_J60: ShippedTrialTemplate = {
  type: 'TRIAL_FOLLOWUP_J60',
  subject: 'Votre espace Verebona reste disponible',
  body: `Bonjour {{firstName}},

Votre période d’essai Verebona s’est terminée il y a quelque temps.

Nous souhaitions simplement vous rappeler que vos informations restent disponibles en consultation et que vous pouvez reprendre l’utilisation du service en activant un abonnement.

Les offres Standard, Premium et Premium Duo permettent de choisir le niveau de service correspondant à vos besoins.

Consulter les offres Verebona : {{offersUrl}}

Il s’agit de notre dernière relance dans le cadre de votre essai gratuit.

Ne plus recevoir de communications commerciales : {{unsubscribeUrl}}`,
  placeholders: ['firstName', 'offersUrl', 'unsubscribeUrl'],
};

/**
 * J+80 — créé, JAMAIS envoyable tant que la conservation n'est pas fixée ET
 * appliquée (verrou serveur, `retention.ts`). La « condition préalable » du
 * document PO est une consigne, pas un texte de l'e-mail.
 */
export const TRIAL_TEMPLATE_J80: ShippedTrialTemplate = {
  type: 'TRIAL_DATA_RETENTION_J80',
  subject: 'Vos données Verebona : encore {{daysRemaining}} jours pour les récupérer',
  body: `Bonjour {{firstName}},

Votre période d’essai Verebona est terminée, mais vos informations sont toujours disponibles en consultation.

Il vous reste {{daysRemaining}} jours, soit jusqu’au {{dataDeletionDate}}, pour retrouver et exporter vos données.

Passé cette date, en l’absence de souscription, votre compte et ses données seront supprimés conformément aux conditions de conservation applicables.

Vous pouvez soit reprendre l’utilisation de Verebona en choisissant un abonnement, soit récupérer vos informations en les exportant avant cette échéance.

Découvrir les offres et souscrire : {{offersUrl}}

Exporter mes données : {{exportUrl}}

Ne plus recevoir de communications commerciales : {{unsubscribeUrl}}`,
  placeholders: ['firstName', 'daysRemaining', 'dataDeletionDate', 'offersUrl', 'exportUrl', 'unsubscribeUrl'],
};

export const TRIAL_SHIPPED_TEMPLATES: readonly ShippedTrialTemplate[] = [
  TRIAL_TEMPLATE_J_MINUS_2, TRIAL_TEMPLATE_J0, TRIAL_TEMPLATE_J3, TRIAL_TEMPLATE_J10,
  TRIAL_TEMPLATE_J30, TRIAL_TEMPLATE_J60, TRIAL_TEMPLATE_J80,
];

/**
 * Anciens modèles d'essai : plus jamais envoyés (lot 100G, un seul circuit).
 * Conservés en base (historique), retirés de l'envoi.
 */
export const RETIRED_TRIAL_TEMPLATES: readonly string[] = ['TRIAL_REMINDER_J3', 'TRIAL_REMINDER_J1', 'TRIAL_ENDED'];

/**
 * Mentions obsolètes de l'ancienne offre d'essai (60 jours, 2 mois offerts,
 * passage automatique à 59 €) — l'essai actuel dure 7 jours, sans prélèvement.
 * Contrôle des modèles en base (supervision BO) et des sources (tests).
 */
export const OBSOLETE_TRIAL_MENTION = /(?:\b60\s*(?:jours|days)\b|\b59\s*(?:€|&euro;|euros?\b)|\b(?:2|deux)\s*mois\s*(?:offerts|gratuits)\b|essai\s+de\s+60)/i;
