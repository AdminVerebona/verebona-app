import { WELCOME_HTML, DUO_INVITATION_DEFAULT_HTML, PREMIUM_CONFIRMATION_DEFAULT_HTML, TRIAL_CONFIRMATION_DEFAULT_HTML } from '@/lib/email/email-html-templates';

// Templates par défaut pour réinitialisation
export const DEFAULT_EMAIL_TEMPLATES = {
  WELCOME: {
    subject: 'Bienvenue sur Verebona !',
    body: WELCOME_HTML,
    placeholders: JSON.stringify(['firstName', 'loginUrl', 'logoUrl', 'year'])
  },
  
  PASSWORD_RESET: {
    subject: 'Réinitialisation de votre mot de passe',
    body: `Bonjour {{firstName}},

Vous avez demandé la réinitialisation de votre mot de passe.

Cliquez sur le lien ci-dessous pour définir un nouveau mot de passe :

{{resetUrl}}

Ce lien est valable pendant 1 heure.

Si vous n'êtes pas à l'origine de cette demande, ne cliquez pas sur le lien de réinitialisation. Si vous avez un doute concernant la sécurité de votre compte, modifiez votre mot de passe directement depuis Verebona.

Cordialement,
L'équipe Verebona`,
    placeholders: JSON.stringify(['firstName', 'email', 'resetUrl'])
  },
  
  // Lot 38 (volet B) : réutilisation d'un jeton de renouvellement au-delà de
  // la fenêtre de grâce → toutes les sessions révoquées (lot 37, C2). E-mail
  // de sécurité envoyé après la réponse, au plus un par heure et par
  // utilisateur, sans aucune donnée sensible (ni IP, ni appareil). Gabarit
  // inséré par la migration 0314, modifiable dans le BO (Communications).
  SECURITY_SESSIONS_REVOKED: {
    subject: 'Verebona : vos appareils ont été déconnectés par précaution',
    body: `Bonjour {{firstName}},

Par précaution, nous avons déconnecté vos appareils de votre compte Verebona le {{incidentDate}} : une ancienne session a tenté de se reconnecter alors qu'elle avait déjà été renouvelée.

Pour continuer à utiliser Verebona, reconnectez-vous simplement :

{{loginUrl}}

Si ce n'était pas vous, ou en cas de doute, changez votre mot de passe dès maintenant avec « Mot de passe oublié » :

{{forgotPasswordUrl}}

Cordialement,
L'équipe Verebona`,
    placeholders: JSON.stringify(['firstName', 'incidentDate', 'loginUrl', 'forgotPasswordUrl'])
  },

  // Lot 53A (retour PO Q21, CDC 18 §7.1) : inscription non énumérable — une
  // adresse déjà inscrite reçoit cet e-mail au lieu d'un refus « adresse déjà
  // utilisée ». Gabarit inséré par la migration 0342, modifiable dans le BO.
  SIGNUP_EXISTING_ACCOUNT: {
    subject: 'Verebona : vous avez déjà un compte',
    body: `Bonjour {{firstName}},

Une demande de création de compte Verebona a été faite avec votre adresse e-mail le {{requestDate}}.

Vous avez déjà un compte Verebona avec cette adresse : aucun nouveau compte n'a été créé et votre compte n'a pas été modifié.

Pour vous connecter :

{{loginUrl}}

Mot de passe oublié ? Choisissez-en un nouveau ici :

{{forgotPasswordUrl}}

Si vous n'êtes pas à l'origine de cette demande, ignorez simplement ce message.

Cordialement,
L'équipe Verebona`,
    placeholders: JSON.stringify(['firstName', 'requestDate', 'loginUrl', 'forgotPasswordUrl'])
  },

  // Lot 64A (migration 0459) : fin de l'accès d'un membre à un Premium Duo.
  // Jamais de motif (rétractation, impayé…) ni d'e-mail du titulaire.
  DUO_MEMBERSHIP_ENDED: {
    subject: "Votre accès à l'espace Premium Duo a pris fin",
    body: `Bonjour {{firstName}},

L'espace Premium Duo que vous partagiez avec {{ownerFirstName}} a pris fin.

Ce qui change pour vous : vous n'avez plus accès à l'espace partagé, ni aux biens, documents et échéances qui y sont rattachés. Votre compte revient à votre propre offre (Standard si vous n'avez pas d'abonnement personnel).

Ce qui ne change pas : votre compte et vos données personnelles sont conservés. Rien n'a été supprimé de votre propre espace.

Accéder à mon compte : {{accountUrl}}

Voir mon offre : {{subscriptionUrl}}

Cordialement,
L'équipe Verebona`,
    placeholders: JSON.stringify(['firstName', 'ownerFirstName', 'accountUrl', 'subscriptionUrl'])
  },

  // Lot 65A (migration 0462) : confirmation au membre qui QUITTE lui-même un
  // Premium Duo. Gabarit dédié (son action, pas une fin subie) ; mêmes
  // variables et même discrétion que DUO_MEMBERSHIP_ENDED.
  DUO_MEMBERSHIP_LEFT: {
    subject: "Vous avez quitté l'espace Premium Duo",
    body: `Bonjour {{firstName}},

Vous avez quitté l'espace Premium Duo que vous partagiez avec {{ownerFirstName}}. Votre départ a bien été pris en compte.

Ce qui change pour vous : vous n'avez plus accès à l'espace partagé, ni aux biens, documents et échéances qui y sont rattachés. Votre compte revient à votre propre offre (Standard si vous n'avez pas d'abonnement personnel).

Ce qui ne change pas : votre compte et vos données personnelles sont conservés. Rien n'a été supprimé de votre propre espace.

Pour rejoindre à nouveau cet espace, une nouvelle invitation du titulaire sera nécessaire. Si vous n'êtes pas à l'origine de ce départ, contactez notre support en répondant à cet e-mail.

Accéder à mon compte : {{accountUrl}}

Voir mon offre : {{subscriptionUrl}}

Cordialement,
L'équipe Verebona`,
    placeholders: JSON.stringify(['firstName', 'ownerFirstName', 'accountUrl', 'subscriptionUrl'])
  },

  DUO_INVITATION: {
    subject: '{{ownerFirstName}} vous invite à rejoindre son espace Verebona DUO',
    body: DUO_INVITATION_DEFAULT_HTML,
    placeholders: JSON.stringify(['ownerFirstName', 'ownerLastName', 'ownerFullName', 'inviteUrl', 'expiresIn', 'logoUrl', 'year'])
  },

  PREMIUM_CONFIRMATION: {
    subject: 'Confirmation de votre abonnement Verebona Premium',
    body: PREMIUM_CONFIRMATION_DEFAULT_HTML,
    placeholders: JSON.stringify(['firstName', 'logoUrl', 'nextBillingDate', 'planLabel', 'amountLabel', 'periodLabel', 'year'])
  },

  SUBSCRIPTION_EXPIRING: {
    subject: 'Votre abonnement Verebona expire bientôt',
    body: `Bonjour {{firstName}},

Nous vous informons que votre abonnement {{planType}} arrive à expiration le {{expiryDate}}.

Pour continuer à profiter de tous les avantages de Verebona sans interruption, pensez à renouveler votre abonnement.

Renouveler maintenant : {{renewUrl}}

Rappel de vos avantages {{planType}} :
• {{feature1}}
• {{feature2}}
• {{feature3}}

Pour toute question, notre équipe est à votre disposition.

Cordialement,
L'équipe Verebona`,
    placeholders: JSON.stringify(['firstName', 'planType', 'expiryDate', 'renewUrl', 'feature1', 'feature2', 'feature3'])
  },

  TRIAL_CONFIRMATION: {
    subject: "Activation de votre période d'essai de 2 mois sur Verebona Premium",
    body: TRIAL_CONFIRMATION_DEFAULT_HTML,
    placeholders: JSON.stringify(['firstName', 'logoUrl', 'trialEndsAt', 'loginUrl', 'year'])
  }
} as const;

export type TemplateType = keyof typeof DEFAULT_EMAIL_TEMPLATES;