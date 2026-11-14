/**
 * Carte #774 — e-mails de sécurité « Clé d'accès ajoutée » et « Application
 * d'authentification activée » sur le gabarit transactionnel COMMUN
 * (`transactional-template.ts`).
 *
 * Deux gabarits DISTINCTS au niveau métier (objet, pré-en-tête, titre, textes),
 * une seule structure HTML / texte. Les textes sont ceux du ticket #774 (§2 et
 * §2 bis), repris tels quels ; les rares textes ajoutés sont listés « à valider
 * par le PO » dans `docs/exploitation/recette-114m-emails-transactionnels.md`.
 *
 * Source unique : la migration 1698 insère ces corps (contrôlé par
 * `__tests__/l114m-emails-securite.test.ts`), l'éditeur du BO s'en sert comme
 * texte « livré ».
 *
 * Variables fournies par l'application :
 *   · `{{eventWhen}}`  date et heure RÉELLES de l'événement, Europe/Paris
 *     (« le 13 novembre 2026 à 17 h 06 (heure de Paris) ») — jamais la date
 *     d'envoi ; « récemment » si l'horodatage est inexploitable (rien d'inventé) ;
 *   · `{{actionUrl}}`  Mon compte › Sécurité (lien interne, sans jeton) ;
 *   · `{{supportEmail}}` adresse d'assistance CONFIGURÉE (BO › réglages e-mail) ;
 *   · `{{year}}`, `{{logoUrl}}` (service d'e-mail).
 * Aucun secret, aucun code, aucun identifiant ni nom de clé.
 */
import { buildTransactionalEmailHtml, type TransactionalEmailSpec } from './transactional-template';

export { PASSKEY_ADDED_TEMPLATE_CODE, TOTP_ENABLED_TEMPLATE_CODE } from '../auth/security-email';


const HEADER_LABEL = 'Notification de sécurité';
const CTA = { href: '{{actionUrl}}', label: 'Vérifier la sécurité de mon compte' } as const;
const CTA_NOTE = 'Vous pouvez également ouvrir Verebona directement et accéder à Mon compte > Sécurité.';
const FOOTER = {
  help: "Besoin d'aide ? Contactez l'assistance Verebona.",
  supportEmailVariable: 'supportEmail',
  copyright: '© {{year}} Verebona',
} as const;
/** Recours quand la remédiation autonome échoue (texte du ticket, §2 bis). */
const SUPPORT_FALLBACK = "Si vous ne parvenez pas à sécuriser votre compte, contactez l'assistance Verebona.";

export const PASSKEY_ADDED_SUBJECT = "Une clé d'accès a été ajoutée à votre compte Verebona";
export const PASSKEY_ADDED_SPEC: TransactionalEmailSpec = {
  documentTitle: PASSKEY_ADDED_SUBJECT,
  preheader: "Vérifiez cet ajout si vous n'en êtes pas à l'origine.",
  headerLabel: HEADER_LABEL,
  h1: "Une nouvelle clé d'accès a été ajoutée",
  intro: ["Une clé d'accès a été enregistrée sur votre compte Verebona {{eventWhen}}."],
  sections: [
    { heading: "Vous êtes à l'origine de cet ajout ?", paragraphs: ["Aucune action n'est nécessaire."] },
    {
      heading: 'Vous ne reconnaissez pas cet ajout ?',
      paragraphs: ['Vérifiez immédiatement les méthodes de connexion associées à votre compte :'],
      steps: [
        "Supprimez toute clé d'accès inconnue.",
        "Déconnectez les appareils/sessions suspects si l'application permet de le faire.",
        'Changez votre mot de passe.',
      ],
      after: [SUPPORT_FALLBACK],
    },
  ],
  cta: CTA,
  ctaNote: CTA_NOTE,
  footer: FOOTER,
};

export const TOTP_ENABLED_SUBJECT = "Une application d'authentification a été activée sur votre compte Verebona";
export const TOTP_ENABLED_SPEC: TransactionalEmailSpec = {
  documentTitle: TOTP_ENABLED_SUBJECT,
  preheader: "Si vous n'êtes pas à l'origine de cette activation, vérifiez la sécurité de votre compte.",
  headerLabel: HEADER_LABEL,
  h1: "Application d'authentification activée",
  intro: ["Une application d'authentification a été activée sur votre compte Verebona {{eventWhen}}."],
  sections: [
    { heading: "Vous êtes à l'origine de cette activation ?", paragraphs: ["Aucune action n'est nécessaire."] },
    {
      heading: 'Vous ne reconnaissez pas cette activation ?',
      steps: [
        'Ouvrez Verebona, puis Mon compte > Sécurité.',
        "Vérifiez les méthodes de connexion et désactivez la méthode d'authentification inconnue.",
        'Vérifiez les appareils ou sessions suspects et révoquez-les si cette fonction existe.',
        'Changez votre mot de passe.',
      ],
      after: [SUPPORT_FALLBACK],
    },
  ],
  cta: CTA,
  ctaNote: CTA_NOTE,
  footer: FOOTER,
};

export const PASSKEY_ADDED_HTML = buildTransactionalEmailHtml(PASSKEY_ADDED_SPEC);
export const TOTP_ENABLED_HTML = buildTransactionalEmailHtml(TOTP_ENABLED_SPEC);

/** Gabarits livrés (clé : type en majuscules) — objet et corps. */
export const SECURITY_NOTIFICATION_TEMPLATES: Readonly<Record<string, { subject: string; body: string }>> = {
  NOTIF_MFA_PASSKEY_ADDED: { subject: PASSKEY_ADDED_SUBJECT, body: PASSKEY_ADDED_HTML },
  NOTIF_MFA_TOTP_ENABLED: { subject: TOTP_ENABLED_SUBJECT, body: TOTP_ENABLED_HTML },
};
