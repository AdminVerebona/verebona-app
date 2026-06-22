import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { eq, or } from 'drizzle-orm';

async function main() {
    const templateTypes = [
        'EMAIL_VERIFICATION',
        'WELCOME',
        'PASSWORD_RESET',
        'DEADLINE_REMINDER',
        'DEADLINE_OVERDUE',
        'PREMIUM_CONFIRMATION'
    ];

    await db.delete(emailTemplates)
        .where(
            or(
                eq(emailTemplates.type, 'EMAIL_VERIFICATION'),
                eq(emailTemplates.type, 'WELCOME'),
                eq(emailTemplates.type, 'PASSWORD_RESET'),
                eq(emailTemplates.type, 'DEADLINE_REMINDER'),
                eq(emailTemplates.type, 'DEADLINE_OVERDUE'),
                eq(emailTemplates.type, 'PREMIUM_CONFIRMATION')
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
            body: `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bienvenue sur Verebona</title>
  </head>

  <body style="margin:0; padding:0; background-color:#F5F5F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <center>
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5; padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:8px; overflow:hidden; margin:0 auto;">
              
              <!-- HEADER -->
              <tr>
                <td align="center" style="padding:32px 24px; text-align:center; border-bottom:1px solid #E5E7EB;">
                  
                  <!-- LOGO IMAGE UNIQUEMENT - centré précisément à l'endroit du texte bleu -->
                  <center>
                    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                      <tr>
                        <td align="center" style="text-align:center;">
                          <img 
                            src="{{logoUrl}}" 
                            alt="Verebona" 
                            width="400" 
                            style="display:block; width:400px; max-width:100%; height:auto; border:0; outline:none; margin:0 auto; object-fit:contain;"
                          />
                        </td>
                      </tr>
                    </table>
                  </center>

                </td>
              </tr>

              <!-- BODY -->
              <tr>
                <td style="padding:32px 32px 24px; color:#2F3941; font-size:16px; line-height:1.6;">
                  
                  <p style="margin:0 0 16px 0;">Bonjour {{firstName}},</p>

                  <p style="margin:0 0 16px 0;">
                    Bienvenue sur <strong>Verebona</strong> — votre espace personnel pour organiser, suivre et valoriser l'ensemble de vos biens et documents importants.
                  </p>

                  <p style="margin:0 0 24px 0;">
                    Votre compte est maintenant activé. Vous pouvez vous connecter dès maintenant :
                  </p>

                  <!-- CTA BUTTON -->
                  <p style="text-align:center; margin:24px 0;">
                    <a 
                      href="{{loginUrl}}"
                      style="background-color:#3B82F6; padding:12px 24px; border-radius:6px; color:#FFFFFF; font-size:16px; font-weight:600; text-decoration:none; display:inline-block;"
                    >
                      Accéder à mon espace
                    </a>
                  </p>

                  <p style="margin:24px 0 0; font-size:14px; color:#6B7280;">
                    Si vous n'êtes pas à l'origine de cette inscription, vous pouvez ignorer ce message.
                  </p>
                </td>
              </tr>

              <!-- FOOTER -->
              <tr>
                <td style="padding:20px 24px; text-align:center; color:#6B7280; font-size:12px; border-top:1px solid #E5E7EB;">
                  <p style="margin:0 0 6px 0;">© {{year}} Verebona • Tous droits réservés</p>
                  <p style="margin:0;">One place. Higher value</p>
                </td>
              </tr>
            
            </table>
          </td>
        </tr>
      </table>
    </center>
  </body>
</html>`,
            placeholders: JSON.stringify(['firstName', 'loginUrl', 'logoUrl', 'year']),
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
        {
            type: 'PASSWORD_RESET',
            subject: 'Réinitialisation de votre mot de passe - Verebona',
            body: 'Bonjour {{firstName}},\n\nVous avez demandé la réinitialisation de votre mot de passe Verebona.\n\nPour définir un nouveau mot de passe, cliquez sur le lien ci-dessous :\n{{resetUrl}}\n\nCe lien expirera dans {{expiresAt}}.\n\nSi vous n\'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.\n\nCordialement,\nL\'équipe Verebona',
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
            body: `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Confirmation abonnement Premium</title>
  </head>

  <body style="margin:0; padding:0; background-color:#F5F5F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5; padding:40px 0;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:8px; overflow:hidden;">
            
            <!-- HEADER -->
            <tr>
              <td style="padding:32px 24px; text-align:center; border-bottom:1px solid #E5E7EB;">
                <img 
                  src="{{logoUrl}}" 
                  alt="Verebona Logo" 
                  width="80" 
                  height="80" 
                  style="display:block; margin:0 auto 12px; object-fit: contain;"
                />
                <div style="font-family:'Inter',sans-serif; font-size:28px; font-weight:600; color:#1E3A8A; margin-bottom:4px;">
                  Verebona Premium
                </div>
                <div style="color:#3B82F6; font-size:14px; font-weight:600;">✨ Abonnement activé</div>
              </td>
            </tr>

            <!-- BODY -->
            <tr>
              <td style="padding:32px; color:#2F3941; font-size:16px; line-height:1.6;">
                
                <p style="margin:0 0 16px 0;">Bonjour {{firstName}},</p>

                <p style="margin:0 0 24px 0;">
                  Nous vous confirmons l'activation de votre abonnement <strong>Verebona Premium</strong>. 
                  Vous avez désormais accès à toutes les fonctionnalités Premium de la plateforme.
                </p>

                <!-- SUBSCRIPTION DETAILS BOX -->
                <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F6; border-radius:8px; margin:24px 0;">
                  <tr>
                    <td style="padding:20px;">
                      <p style="margin:0 0 12px 0; font-weight:600; color:#1F2937;">Détails de votre abonnement</p>
                      <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;">
                        <strong>Offre :</strong> Verebona Premium
                      </p>
                      <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;">
                        <strong>Montant :</strong> 59 € / an, TTC, TVA incluse
                      </p>
                      <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;">
                        <strong>Périodicité :</strong> Abonnement annuel à reconduction tacite
                      </p>
                      <p style="margin:0; font-size:14px; color:#4B5563;">
                        <strong>Prochaine échéance :</strong> {{nextBillingDate}}
                      </p>
                    </td>
                  </tr>
                </table>

                <p style="margin:24px 0 16px 0;">
                  Votre abonnement sera automatiquement renouvelé à la date d'échéance, sauf résiliation de votre part.
                </p>

                <!-- INFO BOX -->
                <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#EFF6FF; border-left:4px solid #3B82F6; border-radius:4px; margin:24px 0;">
                  <tr>
                    <td style="padding:16px; font-size:14px; color:#1E3A8A;">
                      Vous pouvez gérer ou résilier votre abonnement à tout moment depuis votre compte, 
                      via le portail Stripe sécurisé accessible depuis la page "Mon abonnement".
                    </td>
                  </tr>
                </table>

                <p style="margin:24px 0 16px 0;">
                  À défaut de renouvellement, votre compte sera automatiquement basculé vers l'offre Standard.
                </p>

                <!-- CTA BUTTON -->
                <p style="text-align:center; margin:32px 0;">
                  <a 
                    href="{{manageSubscriptionUrl}}"
                    style="background-color:#3B82F6; padding:12px 24px; border-radius:6px; color:#FFFFFF; font-size:16px; font-weight:600; text-decoration:none; display:inline-block;"
                  >
                    Gérer mon abonnement
                  </a>
                </p>

                <p style="margin:24px 0 0; font-size:14px; color:#6B7280;">
                  Merci de votre confiance et bienvenue dans l'univers Premium de Verebona !
                </p>
              </td>
            </tr>

            <!-- FOOTER -->
            <tr>
              <td style="padding:20px 24px; text-align:center; color:#6B7280; font-size:12px; border-top:1px solid #E5E7EB;">
                <p style="margin:0 0 6px 0;">© {{year}} Verebona • Tous droits réservés</p>
                <p style="margin:0 0 12px 0;">One place. Higher value</p>
                <p style="margin:0; font-size:11px;">
                  Des questions ? Contactez-nous à support@verebona.com
                </p>
              </td>
            </tr>
          
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
            placeholders: JSON.stringify(['firstName', 'logoUrl', 'nextBillingDate', 'manageSubscriptionUrl', 'year']),
            triggerConfig: null,
            sender: null,
            updatedAt: new Date(),
            updatedBy: null,
        },
    ];

    await db.insert(emailTemplates).values(sampleTemplates);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});