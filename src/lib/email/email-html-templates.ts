/**
 * Lot 66C — gabarits d'e-mails HTML COMPLETS livrés par Verebona, à la charte
 * « Sérénité » 2026 (mise en page commune `email-layout.ts`).
 *
 * Source unique des corps HTML repris par les amorçages (`src/db/seeds/**`), les
 * défauts du code (`lib/email-defaults.ts`) et la migration 0465 (mise à jour des
 * gabarits en base NON personnalisés). Les TEXTES, variables `{{…}}` et liens sont
 * ceux livrés au lot 65, à l'identique (contrôlé par `__tests__/l66c-email-charte.test.ts`
 * contre `fixtures/l66c-email-lot65.json`) ; seule la présentation change.
 *
 * Les gabarits stockés en base ne chargent pas Figtree (aucune URL d'application ne
 * peut y être figée) : pile Figtree → Arial / Helvetica. Le logo reste `{{logoUrl}}`,
 * remplacé à l'envoi par le bloc logo hébergé (`EmailService.getVerebonaEmailLogo`).
 */
import { EMAIL_COLORS as C, EMAIL_FONT_STACK as F, EMAIL_STYLES as S, emailButton, emailCallout, emailDocument } from './email-layout';

const p = (html: string) => `<p style="${S.p}">${html}</p>`;
const muted = (html: string) => `<p class="vb-muted" style="${S.muted}">${html}</p>`;
const h1 = (html: string) => `<h1 style="${S.h1}">${html}</h1>`;
const eyebrow = (html: string) => `<p class="vb-eyebrow" style="${S.eyebrow}">${html}</p>`;
/** `<strong>` nu : la couleur est héritée (et passe en clair en mode sombre). */
const strong = (html: string) => `<strong>${html}</strong>`;
const link = (href: string, html: string) => `<a class="vb-link" href="${href}" style="${S.link}">${html}</a>`;
const foot = (...lines: string[]) => lines.map((l, i) => `<p class="vb-foot" style="margin:0 0 ${i === lines.length - 1 ? 0 : 6}px 0;${S.small}">${l}</p>`).join('\n');
/** Mot-symbole texte (gabarits légaux sans image : leur en-tête « Verebona » est conservé tel quel). */
const wordmark = `<p class="vb-wordmark" style="margin:0;font-family:${F};font-size:22px;font-weight:700;letter-spacing:-0.02em;color:${C.petrole};">Verebona</p>`;
/** Document stocké en base : logo `{{logoUrl}}` (remplacé à l'envoi), sans @font-face. */
const doc = (title: string, content: string, footer: string, logo = '{{logoUrl}}') =>
  emailDocument({ title, content, footer, logo, baseUrl: '', fontFace: false });

const FOOT_COPYRIGHT = '© {{year}} Verebona • Tous droits réservés';
const FOOT_TAGLINE = 'One place. Higher value';
const FOOT_MEMBERSHIP = '© {{year}} Verebona. Tous droits réservés.';
const TRIAL_FOOT_LINES = [
  "Aucune carte bancaire n'a ete enregistree et aucun prelevement automatique n'aura lieu.",
  'Vos donnees restent conservees. Pour continuer a ajouter et modifier vos biens et documents, il vous suffit de choisir une offre.',
];

// ───────────────────────────── Compte ─────────────────────────────

export const WELCOME_HTML = doc('Bienvenue sur Verebona', [
  p('Bonjour {{firstName}},'),
  p(`Bienvenue sur ${strong('Verebona')} — votre espace personnel pour organiser, suivre et valoriser l'ensemble de vos biens et documents importants.`),
  p('Votre compte est maintenant activé. Vous pouvez vous connecter dès maintenant :'),
  emailButton('{{loginUrl}}', 'Accéder à mon espace'),
  muted("Si vous n'êtes pas à l'origine de cette inscription, vous pouvez ignorer ce message."),
].join('\n'), foot(FOOT_COPYRIGHT, FOOT_TAGLINE));

// ───────────────────────────── Abonnement ─────────────────────────────

const premiumDetails = (lines: string[]) => emailCallout([
  `<p class="vb-eyebrow" style="${S.eyebrow}">Détails de votre abonnement</p>`,
  ...lines.map((l, i) => `<p style="margin:0 0 ${i === lines.length - 1 ? 0 : 6}px 0;font-family:${F};font-size:15px;line-height:1.6;color:${C.encre};">${l}</p>`),
].join(''));
const PREMIUM_LINES = [
  `${strong('Offre :')} Verebona {{planLabel}}`,
  `${strong('Montant :')} {{amountLabel}}`,
  `${strong('Périodicité :')} {{periodLabel}}`,
  `${strong('Prochaine échéance :')} {{nextBillingDate}}`,
];

/** PREMIUM_CONFIRMATION tel qu'amorcé en base (`email_templates_system.ts`). */
export const PREMIUM_CONFIRMATION_HTML = doc('Confirmation de votre abonnement Verebona Premium', [
  eyebrow('Verebona Premium'),
  h1('✨ Abonnement activé'),
  p('Bonjour {{firstName}},'),
  p(`Nous vous confirmons l'activation de votre abonnement ${strong('Verebona Premium')}. Vous avez désormais accès à toutes les fonctionnalités Premium de la plateforme.`),
  premiumDetails(PREMIUM_LINES),
  p("Votre abonnement sera automatiquement renouvelé à la date d'échéance, sauf résiliation de votre part."),
  emailCallout('Vous pouvez gérer ou résilier votre abonnement à tout moment depuis votre compte.'),
  p("Merci de votre confiance et bienvenue dans l'univers Premium de Verebona !"),
].join('\n'), foot(FOOT_COPYRIGHT, FOOT_TAGLINE, 'Des questions ? Contactez-nous à support@verebona.com'));

/** PREMIUM_CONFIRMATION des défauts du code (`lib/email-defaults.ts`). */
export const PREMIUM_CONFIRMATION_DEFAULT_HTML = doc('Confirmation de votre abonnement Verebona Premium', [
  h1('✨ Abonnement activé'),
  p('Bonjour {{firstName}},'),
  p(`Nous vous confirmons l'activation de votre abonnement ${strong('Verebona Premium')}. Vous avez désormais accès à toutes les fonctionnalités Premium de la plateforme.`),
  premiumDetails(PREMIUM_LINES),
  p('Vous pouvez gérer ou résilier votre abonnement à tout moment depuis votre compte.'),
  p("Merci de votre confiance et bienvenue dans l'univers Premium de Verebona !"),
].join('\n'), foot(FOOT_COPYRIGHT, FOOT_TAGLINE));

/**
 * TRIAL_CONFIRMATION des défauts du code (la base garde son gabarit texte).
 * Lot 100G (E2) : l'ancien texte annonçait un essai de 60 jours (« 2 mois
 * offerts ») et un passage automatique à 59 € par an — faux. L'essai dure 7
 * jours, sans carte bancaire ni prélèvement (aucun appelant n'envoie ce modèle).
 */
export const TRIAL_CONFIRMATION_DEFAULT_HTML = doc("Activation de votre période d'essai", [
  h1("🎁 Période d'essai activée"),
  p('Bonjour {{firstName}},'),
  p(`Votre essai gratuit ${strong('Verebona')} de 7 jours est ouvert. Il prendra fin le ${strong('{{trialEndsAt}}')}.`),
  emailCallout("Aucune carte bancaire n'est demandée et aucun prélèvement automatique n'aura lieu à la fin de votre essai."),
  emailButton('{{loginUrl}}', 'Accéder à Verebona'),
].join('\n'), foot(FOOT_COPYRIGHT, FOOT_TAGLINE));

// ───────────────────────────── Essai (rappels, fin) ─────────────────────────────

const trial = (title: string, heading: string, intro: string, paragraph: string, cta: string) => doc(title, [
  h1(heading),
  p('Bonjour {{firstName}},'),
  p(intro),
  p(paragraph),
  emailButton('{{offersUrl}}', cta),
].join('\n'), foot(...TRIAL_FOOT_LINES));

export const TRIAL_REMINDER_J3_HTML = trial(
  'Votre essai Verebona',
  "Plus que {{daysRemaining}} jours d'essai",
  "Votre essai Premium se termine le {{trialEndsAt}}. D'ici la, vous continuez a profiter de l'ensemble des fonctionnalites : analyse automatique de vos documents, agenda de vos echeances, dossiers prets a utiliser et reponses a vos questions.",
  "Si Verebona vous est utile, choisissez des maintenant l'offre qui vous convient — mensuelle ou annuelle, sans engagement.",
  'Voir les offres',
);
export const TRIAL_REMINDER_J1_HTML = trial(
  'Votre essai Verebona',
  'Votre essai se termine demain',
  "Votre essai Premium prend fin le {{trialEndsAt}}. Passe cette date, l'ajout et la modification de vos biens et documents seront suspendus, mais vous garderez l'acces a tout ce que vous avez enregistre.",
  'Pour continuer sans interruption, choisissez votre offre en quelques instants.',
  'Choisir une offre',
);
export const TRIAL_ENDED_HTML = trial(
  'Votre essai Verebona',
  'Votre essai gratuit est termine',
  "Votre essai Premium de 7 jours vient de s'achever. Vos biens, vos documents et vos echeances sont intacts et restent consultables.",
  "Pour reprendre l'ajout et la modification, ainsi que les fonctionnalites Premium, choisissez l'offre adaptee a vos besoins. Trois formules sont disponibles, en paiement mensuel ou annuel.",
  'Decouvrir les offres',
);

// ───────────────────────────── Comptes partagés ─────────────────────────────

export const ACCOUNT_INVITATION_HTML = doc('Invitation à rejoindre un compte Verebona', [
  h1('Invitation à rejoindre un compte'),
  p('Bonjour,'),
  p(`${strong('{{inviterName}}')} vous invite à rejoindre le compte ${strong('{{accountName}}')} sur Verebona avec le rôle ${strong('{{role}}')}.`),
  p('En rejoignant ce compte, vous aurez accès aux biens, documents et événements partagés par les membres du compte.'),
  emailButton('{{invitationLink}}', "Accepter l'invitation"),
  muted('Si vous ne souhaitez pas accepter cette invitation, vous pouvez simplement ignorer cet email.'),
  muted(`Si le bouton ne fonctionne pas, copiez-collez ce lien dans votre navigateur :<br><a class="vb-link" href="{{invitationLink}}" style="${S.linkBreak}">{{invitationLink}}</a>`),
].join('\n'), foot(FOOT_MEMBERSHIP));

export const ACCOUNT_MEMBER_REMOVED_HTML = doc('Retrait d\'un compte Verebona', [
  h1("Retrait d'un compte"),
  p('Bonjour {{memberName}},'),
  p(`Vous avez été retiré du compte ${strong('{{accountName}}')} par ${strong('{{removedByName}}')}.`),
  p("Vous n'avez plus accès aux biens, documents et événements de ce compte."),
  muted("Si vous pensez qu'il s'agit d'une erreur, veuillez contacter le propriétaire du compte."),
].join('\n'), foot(FOOT_MEMBERSHIP));

export const MEMBER_REMOVED_DUE_TO_DOWNGRADE_HTML = doc('Modification de votre accès Verebona', [
  h1('Modification de votre accès'),
  p('Bonjour {{memberName}},'),
  p(`Votre accès au compte ${strong('{{accountName}}')} a été automatiquement retiré suite à un changement d'abonnement.`),
  emailCallout(`${strong('Raison :')}<br>{{reason}}`, { tone: 'attention' }),
  p("Vous n'avez plus accès aux biens, documents et événements de ce compte. Si le propriétaire du compte décide de passer à une offre Premium permettant plusieurs membres, il pourra vous réinviter."),
  muted("Pour toute question, n'hésitez pas à contacter le propriétaire du compte."),
].join('\n'), foot(FOOT_MEMBERSHIP));

export const ACCOUNT_OWNERSHIP_TRANSFERRED_HTML = doc('Transfert de propriété Verebona', [
  h1('Transfert de propriété'),
  p('Bonjour {{newOwnerName}},'),
  p(`${strong('{{previousOwnerName}}')} vous a transféré la propriété du compte ${strong('{{accountName}}')}.`),
  p('En tant que propriétaire, vous avez maintenant tous les droits sur ce compte : gestion des membres, modification des paramètres, et gestion complète des données.'),
  emailButton('{{dashboardLink}}', 'Accéder au compte'),
].join('\n'), foot(FOOT_MEMBERSHIP));

/** DUO_INVITATION des défauts du code (la base garde son gabarit texte, mis en page par l'enveloppe). */
export const DUO_INVITATION_DEFAULT_HTML = doc('Invitation Verebona Premium Duo', [
  p(`${strong('{{ownerFullName}}')} vous invite à rejoindre son espace Verebona Premium Duo.`),
  p('Premium Duo vous permet de rejoindre un espace Verebona partagé à deux pour gérer des biens, documents et éléments d\'agenda dans un même compte.'),
  emailButton('{{inviteUrl}}', "Accepter l'invitation"),
  muted('Ce lien est valable {{expiresIn}}. Si vous n\'êtes pas à l\'origine de cette demande, ne cliquez pas sur le lien. En cas de doute sur la sécurité de votre compte, modifiez votre mot de passe depuis Verebona.'),
].join('\n'), foot(FOOT_COPYRIGHT));

// ───────────────────────────── Légal ─────────────────────────────

/** LEGAL_CONFIRMATION — `{{subscriptionBlockHtml}}` / `{{withdrawalBlockHtml}}` : HTML produit par `legal-confirmation.service.ts`. */
export const LEGAL_CONFIRMATION_HTML = doc('Confirmation — vos conditions générales Verebona', [
  p('Bonjour {{firstName}},'),
  '{{subscriptionBlockHtml}}',
  p(`${strong('Conditions générales applicables :')} version {{legalVersionCode}}.`),
  p('Vous pouvez les consulter, les enregistrer ou les imprimer à tout moment :'),
  emailButton('{{legalPermalinkUrl}}', 'Consulter la version {{legalVersionCode}}'),
  muted('Ce lien pointe vers la version exacte que vous avez acceptée. Elle ne sera jamais modifiée et restera accessible, y compris si vous fermez votre compte.'),
  '{{withdrawalBlockHtml}}',
  p('Vous pouvez gérer votre abonnement depuis votre compte.'),
  p(`Une question ? Écrivez-nous à ${link('mailto:{{contactEmail}}', '{{contactEmail}}')}.`),
].join('\n'), foot('Verebona — {{year}}'), wordmark);

/** WITHDRAWAL_RECEIPT — accusé de réception de rétractation et au revoir (lot 32). */
export const WITHDRAWAL_RECEIPT_HTML = doc('Rétractation enregistrée — Verebona', [
  p('Bonjour {{firstName}} {{lastName}},'),
  p('Nous avons bien reçu votre déclaration de rétractation. Elle est enregistrée et a été traitée immédiatement.'),
  emailCallout([
    `<p style="margin:0 0 6px 0;">${strong('Référence :')} {{publicReference}}</p>`,
    `<p style="margin:0 0 6px 0;">${strong('Reçue le :')} {{requestedAtLabel}}</p>`,
    `<p style="margin:0 0 6px 0;">${strong('Contrat :')} {{contractLabel}}</p>`,
    `<p style="margin:0;">${strong('Remboursement :')} {{amountLabel}}, intégral</p>`,
  ].join('')),
  `<p class="vb-eyebrow" style="${S.eyebrow}">Ce qui a été fait</p>`,
  `<ul style="margin:0 0 16px 0;padding:0 0 0 20px;">`
    + `<li style="${S.li}">Votre abonnement est annulé : aucun nouveau prélèvement n'interviendra.</li>`
    + `<li style="${S.li}">Le remboursement intégral est ${strong('lancé')} sur votre moyen de paiement d'origine, sans retenue. Selon votre banque, il apparaît sous quelques jours.</li>`
    + `<li style="${S.li}">Votre compte Verebona et ses données (biens, documents, fichiers, échéances, historique de l'assistant) sont ${strong('supprimés')} : vous ne pouvez plus vous y connecter.</li>`
    + `</ul>`,
  p('Seules les informations que la loi nous impose de garder sont conservées, détachées de votre compte : les factures, la preuve de cette rétractation et celle de votre acceptation des conditions générales.'),
  p("Merci d'avoir essayé Verebona. Au revoir, et à bientôt peut-être."),
  p(`Conditions générales applicables : ${link('{{legalPermalinkUrl}}', 'consulter')}.`),
  p(`Une question ? ${link('mailto:{{contactEmail}}', '{{contactEmail}}')}`),
].join('\n'), foot('Conservez ce message : il atteste de la date de votre déclaration.<br />Verebona — {{year}}'), wordmark);

/**
 * Gabarits HTML complets mis à jour par la migration 0465 (type → nouveau corps),
 * uniquement quand le corps en base est celui livré au lot 65 (non personnalisé).
 */
export const EMAIL_HTML_TEMPLATES_L66: Readonly<Record<string, string>> = {
  WELCOME: WELCOME_HTML,
  PREMIUM_CONFIRMATION: PREMIUM_CONFIRMATION_HTML,
  TRIAL_REMINDER_J3: TRIAL_REMINDER_J3_HTML,
  TRIAL_REMINDER_J1: TRIAL_REMINDER_J1_HTML,
  TRIAL_ENDED: TRIAL_ENDED_HTML,
  ACCOUNT_INVITATION: ACCOUNT_INVITATION_HTML,
  ACCOUNT_MEMBER_REMOVED: ACCOUNT_MEMBER_REMOVED_HTML,
  MEMBER_REMOVED_DUE_TO_DOWNGRADE: MEMBER_REMOVED_DUE_TO_DOWNGRADE_HTML,
  ACCOUNT_OWNERSHIP_TRANSFERRED: ACCOUNT_OWNERSHIP_TRANSFERRED_HTML,
  LEGAL_CONFIRMATION: LEGAL_CONFIRMATION_HTML,
  WITHDRAWAL_RECEIPT: WITHDRAWAL_RECEIPT_HTML,
};
