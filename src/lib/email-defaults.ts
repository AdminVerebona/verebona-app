// Templates par défaut pour réinitialisation
export const DEFAULT_EMAIL_TEMPLATES = {
  WELCOME: {
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
                  <!-- LOGO UNIQUEMENT, CENTRÉ AU PIXEL -->
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
    placeholders: JSON.stringify(['firstName', 'loginUrl', 'logoUrl', 'year'])
  },
  
  PASSWORD_RESET: {
    subject: 'Réinitialisation de votre mot de passe',
    body: `Bonjour {{firstName}},

Vous avez demandé la réinitialisation de votre mot de passe.

Cliquez sur le lien ci-dessous pour définir un nouveau mot de passe :

{{resetUrl}}

Ce lien est valable pendant 1 heure.

Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email. Votre mot de passe actuel reste inchangé.

Cordialement,
L'équipe Verebona`,
    placeholders: JSON.stringify(['firstName', 'email', 'resetUrl'])
  },
  
  DUO_INVITATION: {
    subject: '{{ownerFirstName}} vous invite à rejoindre son espace Verebona DUO',
    body: `<!DOCTYPE html>
<html lang="fr">
  <head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Invitation DUO Verebona</title></head>
  <body style="margin:0;padding:0;background-color:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5;padding:40px 0;">
      <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF;border-radius:8px;overflow:hidden;">
          <!-- HEADER -->
          <tr><td style="padding:32px 24px;text-align:center;border-bottom:1px solid #E5E7EB;">
            {{logoUrl}}
          </td></tr>
          <!-- BODY -->
          <tr><td style="padding:32px;color:#2F3941;font-size:16px;line-height:1.6;">
            <p style="margin:0 0 16px 0;"><strong>{{ownerFullName}}</strong> vous invite à rejoindre son espace Verebona Premium Duo.</p>
            <p style="margin:0 0 24px 0;">Premium Duo vous permet de rejoindre un espace Verebona partagé à deux pour gérer des biens, documents et éléments d'agenda dans un même compte.</p>
            <p style="text-align:center;margin:32px 0;">
              <a href="{{inviteUrl}}" style="background-color:#3B82F6;padding:12px 24px;border-radius:6px;color:#FFFFFF;font-size:16px;font-weight:600;text-decoration:none;display:inline-block;">Accepter l'invitation</a>
            </p>
            <p style="margin:24px 0 0;font-size:13px;color:#6B7280;">Ce lien est valable {{expiresIn}}. Si vous n'êtes pas concerné(e), ignorez simplement cet email.</p>
          </td></tr>
          <!-- FOOTER -->
          <tr><td style="padding:20px 24px;text-align:center;color:#6B7280;font-size:12px;border-top:1px solid #E5E7EB;">
            <p style="margin:0 0 6px 0;">© {{year}} Verebona • Tous droits réservés</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
    placeholders: JSON.stringify(['ownerFirstName', 'ownerLastName', 'ownerFullName', 'inviteUrl', 'expiresIn', 'logoUrl', 'year'])
  },

  PREMIUM_CONFIRMATION: {
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
                {{logoUrl}}
                <div style="font-size:14px; font-weight:600; color:#3B82F6; margin-top:12px;">✨ Abonnement activé</div>
              </td>
            </tr>
            <!-- BODY -->
            <tr>
              <td style="padding:32px; color:#2F3941; font-size:16px; line-height:1.6;">
                <p style="margin:0 0 16px 0;">Bonjour {{firstName}},</p>
                <p style="margin:0 0 24px 0;">Nous vous confirmons l'activation de votre abonnement <strong>Verebona Premium</strong>. Vous avez désormais accès à toutes les fonctionnalités Premium de la plateforme.</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F6; border-radius:8px; margin:24px 0;">
                  <tr><td style="padding:20px;">
                    <p style="margin:0 0 12px 0; font-weight:600; color:#1F2937;">Détails de votre abonnement</p>
                    <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;"><strong>Offre :</strong> Verebona Premium</p>
                    <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;"><strong>Montant :</strong> 59 € / an, TTC, TVA incluse</p>
                    <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;"><strong>Périodicité :</strong> Abonnement annuel à reconduction tacite</p>
                    <p style="margin:0; font-size:14px; color:#4B5563;"><strong>Prochaine échéance :</strong> {{nextBillingDate}}</p>
                  </td></tr>
                </table>
                <p style="text-align:center; margin:32px 0;">
                  <a href="{{manageSubscriptionUrl}}" style="background-color:#3B82F6; padding:12px 24px; border-radius:6px; color:#FFFFFF; font-size:16px; font-weight:600; text-decoration:none; display:inline-block;">Gérer mon abonnement</a>
                </p>
                <p style="margin:24px 0 0; font-size:14px; color:#6B7280;">Merci de votre confiance et bienvenue dans l'univers Premium de Verebona !</p>
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
  </body>
</html>`,
    placeholders: JSON.stringify(['firstName', 'logoUrl', 'nextBillingDate', 'manageSubscriptionUrl', 'year'])
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
    body: `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Activation de votre période d'essai Premium</title>
  </head>
  <body style="margin:0; padding:0; background-color:#F5F5F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5; padding:40px 0;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:8px; overflow:hidden;">
            <!-- HEADER -->
            <tr>
              <td style="padding:32px 24px; text-align:center; border-bottom:1px solid #E5E7EB;">
                {{logoUrl}}
                <div style="font-size:14px; font-weight:600; color:#10B981; margin-top:12px;">🎁 Période d'essai activée</div>
              </td>
            </tr>
            <!-- BODY -->
            <tr>
              <td style="padding:32px; color:#2F3941; font-size:16px; line-height:1.6;">
                <p style="margin:0 0 16px 0;">Bonjour {{firstName}},</p>
                <p style="margin:0 0 24px 0;">Nous vous confirmons l'activation de votre offre d'essai <strong>Verebona Premium (2 mois offerts)</strong>. Votre accès Premium est entièrement gratuit pendant 60 jours, soit jusqu'au <strong>{{trialEndsAt}}</strong>.</p>

                <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F6; border-radius:8px; margin:24px 0;">
                  <tr><td style="padding:20px;">
                    <p style="margin:0 0 12px 0; font-weight:600; color:#1F2937;">Résumé de votre offre d'essai</p>
                    <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;"><strong>Offre :</strong> Verebona Premium - Essai de 60 jours</p>
                    <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;"><strong>Montant aujourd'hui :</strong> 0 € (Entièrement gratuit)</p>
                    <p style="margin:0 0 8px 0; font-size:14px; color:#4B5563;"><strong>Date de fin d'essai :</strong> {{trialEndsAt}}</p>
                    <p style="margin:0; font-size:14px; color:#4B5563;"><strong>À la fin de l'essai :</strong> Passage automatique à l'abonnement annuel de 59 € / an (TTC), sauf résiliation préalable.</p>
                  </td></tr>
                </table>

                <p style="margin:0 0 24px 0;">Cette offre est 100 % libre et sans engagement. Vous pouvez annuler votre essai à tout moment et en un seul clic depuis votre compte, via le portail de gestion ("Gérer mon abonnement").</p>

                <p style="text-align:center; margin:32px 0;">
                  <a href="{{loginUrl}}" style="background-color:#3B82F6; padding:12px 24px; border-radius:6px; color:#FFFFFF; font-size:16px; font-weight:600; text-decoration:none; display:inline-block;">Profiter de mon offre</a>
                </p>
                <p style="margin:24px 0 0; font-size:14px; color:#6B7280;">Merci de votre confiance et bonne découverte de Verebona Premium !</p>
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
  </body>
</html>`,
    placeholders: JSON.stringify(['firstName', 'logoUrl', 'trialEndsAt', 'loginUrl', 'year'])
  }
} as const;

export type TemplateType = keyof typeof DEFAULT_EMAIL_TEMPLATES;