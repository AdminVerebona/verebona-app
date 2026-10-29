import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { eq, or } from 'drizzle-orm';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import { WELCOME_HTML, PREMIUM_CONFIRMATION_HTML } from '@/lib/email/email-html-templates';

export async function seedSystemEmailTemplates() {
    const templateTypes = [
        'EMAIL_VERIFICATION',
        'WELCOME',
        'PASSWORD_RESET',
        'DEADLINE_REMINDER',
        'DEADLINE_OVERDUE',
        'PREMIUM_CONFIRMATION',
        'SECURITY_SESSIONS_REVOKED',
        'SIGNUP_EXISTING_ACCOUNT',
        'EMAIL_CHANGE_CONFIRMATION',
        'PRIMARY_EMAIL_CHANGED',
        'EMAIL_CHANGE_ADDRESS_IN_USE',
        'PASSWORD_RESET_SOCIAL_ONLY',
        'SOCIAL_SIGNUP_EMAIL_CODE',
        'DUO_MEMBERSHIP_ENDED',
        'DUO_MEMBERSHIP_LEFT'
    ];

    await db.delete(emailTemplates)
        .where(
            or(
                eq(emailTemplates.type, 'EMAIL_VERIFICATION'),
                eq(emailTemplates.type, 'WELCOME'),
                eq(emailTemplates.type, 'PASSWORD_RESET'),
                eq(emailTemplates.type, 'DEADLINE_REMINDER'),
                eq(emailTemplates.type, 'DEADLINE_OVERDUE'),
                eq(emailTemplates.type, 'PREMIUM_CONFIRMATION'),
                eq(emailTemplates.type, 'SECURITY_SESSIONS_REVOKED'),
                eq(emailTemplates.type, 'SIGNUP_EXISTING_ACCOUNT'),
                eq(emailTemplates.type, 'EMAIL_CHANGE_CONFIRMATION'),
                eq(emailTemplates.type, 'PRIMARY_EMAIL_CHANGED'),
                eq(emailTemplates.type, 'EMAIL_CHANGE_ADDRESS_IN_USE'),
                eq(emailTemplates.type, 'PASSWORD_RESET_SOCIAL_ONLY'),
                eq(emailTemplates.type, 'SOCIAL_SIGNUP_EMAIL_CODE'),
                eq(emailTemplates.type, 'DUO_MEMBERSHIP_ENDED'),
                eq(emailTemplates.type, 'DUO_MEMBERSHIP_LEFT')
            )
        );

    const sampleTemplates = [
        {
            type: 'EMAIL_VERIFICATION',
            subject: 'Vérifiez votre adresse email - Verebona',
            body: 'Bonjour {{firstName}},\n\nMerci de vous être inscrit sur Verebona. Pour activer votre compte, veuillez vérifier votre adresse email en cliquant sur le lien ci-dessous :\n\n{{verificationUrl}}\n\nCe lien est valide pendant 24 heures.\n\nCordialement,\nL\'équipe Verebona',
            placeholders: JSON.stringify(['firstName', 'verificationUrl']),
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'WELCOME',
            subject: 'Bienvenue sur Verebona !',
            body: WELCOME_HTML, // lot 66C : charte « Sérénité » (lib/email/email-html-templates.ts),
            placeholders: JSON.stringify(['firstName', 'loginUrl', 'logoUrl', 'year']),
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'PASSWORD_RESET',
            subject: 'Réinitialisation de votre mot de passe - Verebona',
            body: 'Bonjour {{firstName}},\n\nVous avez demandé la réinitialisation de votre mot de passe Verebona.\n\nPour définir un nouveau mot de passe, cliquez sur le lien ci-dessous :\n{{resetUrl}}\n\nCe lien expirera dans {{expiresAt}}.\n\nSi vous n\'êtes pas à l\'origine de cette demande, ne cliquez pas sur le lien de réinitialisation. Si vous avez un doute concernant la sécurité de votre compte, modifiez votre mot de passe directement depuis Verebona.\n\nCordialement,\nL\'équipe Verebona',
            placeholders: JSON.stringify(['firstName', 'resetUrl', 'expiresAt']),
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'DEADLINE_REMINDER',
            subject: 'Rappel : Échéance à venir - {{deadlineLabel}}',
            body: 'Bonjour {{firstName}},\n\nNous vous rappelons qu\'une échéance approche pour votre bien "{{assetName}}" :\n\nÉchéance : {{deadlineLabel}}\nDate limite : {{deadlineDate}}\n\nPensez à traiter cette échéance dans les prochains jours.\n\nCordialement,\nL\'équipe Verebona',
            placeholders: JSON.stringify(['firstName', 'assetName', 'deadlineLabel', 'deadlineDate']),
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'DEADLINE_OVERDUE',
            subject: 'Échéance dépassée - {{deadlineLabel}}',
            body: 'Bonjour {{firstName}},\n\nL\'échéance suivante pour votre bien "{{assetName}}" est maintenant dépassée :\n\nÉchéance : {{deadlineLabel}}\nDate limite : {{deadlineDate}}\n\nNous vous recommandons de la traiter dès que possible.\n\nCordialement,\nL\'équipe Verebona',
            placeholders: JSON.stringify(['firstName', 'assetName', 'deadlineLabel', 'deadlineDate']),
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'PREMIUM_CONFIRMATION',
            subject: 'Confirmation de votre abonnement Verebona Premium',
            body: PREMIUM_CONFIRMATION_HTML, // lot 66C : charte « Sérénité » ; texte : « Vous pouvez gérer ou résilier votre abonnement à tout moment depuis votre compte. »,
            placeholders: JSON.stringify(['firstName', 'logoUrl', 'nextBillingDate', 'year']),
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 38 (volet B) : sessions révoquées après réutilisation d'un jeton
        // (migration 0314) — même texte que `lib/email-defaults.ts`.
        {
            type: 'SECURITY_SESSIONS_REVOKED',
            subject: DEFAULT_EMAIL_TEMPLATES.SECURITY_SESSIONS_REVOKED.subject,
            body: DEFAULT_EMAIL_TEMPLATES.SECURITY_SESSIONS_REVOKED.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.SECURITY_SESSIONS_REVOKED.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 53A : inscription sur une adresse déjà inscrite (migration 0342)
        // — même texte que `lib/email-defaults.ts`.
        // Lot 96A (migration 0830) — même texte que `lib/email-defaults.ts`.
        {
            type: 'EMAIL_CHANGE_CONFIRMATION',
            subject: DEFAULT_EMAIL_TEMPLATES.EMAIL_CHANGE_CONFIRMATION.subject,
            body: DEFAULT_EMAIL_TEMPLATES.EMAIL_CHANGE_CONFIRMATION.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.EMAIL_CHANGE_CONFIRMATION.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 96A (migration 0830) — même texte que `lib/email-defaults.ts`.
        {
            type: 'PRIMARY_EMAIL_CHANGED',
            subject: DEFAULT_EMAIL_TEMPLATES.PRIMARY_EMAIL_CHANGED.subject,
            body: DEFAULT_EMAIL_TEMPLATES.PRIMARY_EMAIL_CHANGED.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.PRIMARY_EMAIL_CHANGED.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 96A (migration 0830) — même texte que `lib/email-defaults.ts`.
        {
            type: 'EMAIL_CHANGE_ADDRESS_IN_USE',
            subject: DEFAULT_EMAIL_TEMPLATES.EMAIL_CHANGE_ADDRESS_IN_USE.subject,
            body: DEFAULT_EMAIL_TEMPLATES.EMAIL_CHANGE_ADDRESS_IN_USE.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.EMAIL_CHANGE_ADDRESS_IN_USE.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 93 (migration 0809) — même texte que `lib/email-defaults.ts`.
        {
            type: 'PASSWORD_RESET_SOCIAL_ONLY',
            subject: DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET_SOCIAL_ONLY.subject,
            body: DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET_SOCIAL_ONLY.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET_SOCIAL_ONLY.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 93 (migration 0809) — même texte que `lib/email-defaults.ts`.
        {
            type: 'SOCIAL_SIGNUP_EMAIL_CODE',
            subject: DEFAULT_EMAIL_TEMPLATES.SOCIAL_SIGNUP_EMAIL_CODE.subject,
            body: DEFAULT_EMAIL_TEMPLATES.SOCIAL_SIGNUP_EMAIL_CODE.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.SOCIAL_SIGNUP_EMAIL_CODE.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'SIGNUP_EXISTING_ACCOUNT',
            subject: DEFAULT_EMAIL_TEMPLATES.SIGNUP_EXISTING_ACCOUNT.subject,
            body: DEFAULT_EMAIL_TEMPLATES.SIGNUP_EXISTING_ACCOUNT.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.SIGNUP_EXISTING_ACCOUNT.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 64A : fin de l'accès d'un membre à un Premium Duo (migration
        // 0459) — même texte que `lib/email-defaults.ts`.
        {
            type: 'DUO_MEMBERSHIP_ENDED',
            subject: DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_ENDED.subject,
            body: DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_ENDED.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_ENDED.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 65A : départ volontaire du second utilisateur (migration 0462).
        {
            type: 'DUO_MEMBERSHIP_LEFT',
            subject: DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_LEFT.subject,
            body: DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_LEFT.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_LEFT.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        // Lot 68C : rappel J−7 avant renouvellement annuel (migration 0477).
        {
            type: 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER',
            subject: DEFAULT_EMAIL_TEMPLATES.SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER.subject,
            body: DEFAULT_EMAIL_TEMPLATES.SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER.body,
            placeholders: DEFAULT_EMAIL_TEMPLATES.SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER.placeholders,
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
    ];

    await db.insert(emailTemplates).values(sampleTemplates);
    
}

// ⚠️ Exécution CONDITIONNELLE.
//
// Ce module est désormais importable par `/api/cron/seed`, qui l'appelle
// explicitement. Sans cette garde, le seul fait d'importer le fichier
// déclencherait l'amorçage — donc à chaque démarrage du serveur, effaçant
// et réécrivant les gabarits en boucle.
if (process.argv[1]?.includes('email_templates_system')) {
  seedSystemEmailTemplates()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[seed] échec :', error.message);
      process.exit(1);
    });
}
