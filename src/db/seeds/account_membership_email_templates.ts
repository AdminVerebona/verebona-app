import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { eq } from 'drizzle-orm';

const ACCOUNT_MEMBERSHIP_TEMPLATES = [
  {
    code: 'ACCOUNT_INVITATION',
    name: 'Invitation à rejoindre un compte',
    subject: 'Vous êtes invité à rejoindre {{accountName}} sur Verebona',
    bodyHtml: `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invitation à rejoindre un compte</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);">
    <!-- Header -->
    <div style="padding: 32px; text-align: center; border-bottom: 1px solid #e5e7eb;">
      <img src="{{logoUrl}}" alt="Verebona" style="height: 40px; width: auto;">
    </div>

    <!-- Body -->
    <div style="padding: 40px 32px;">
      <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #111827;">
        Invitation à rejoindre un compte
      </h1>

      <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #374151;">
        Bonjour,
      </p>

      <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #374151;">
        <strong>{{inviterName}}</strong> vous invite à rejoindre le compte <strong>{{accountName}}</strong> sur Verebona avec le rôle <strong>{{role}}</strong>.
      </p>

      <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #374151;">
        En rejoignant ce compte, vous aurez accès aux biens, documents et événements partagés par les membres du compte.
      </p>

      <!-- CTA Button -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="{{invitationLink}}" style="display: inline-block; padding: 14px 28px; background-color: #3B82F6; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
          Accepter l'invitation
        </a>
      </div>

      <p style="margin: 24px 0 0; font-size: 14px; line-height: 1.6; color: #6b7280;">
        Si vous ne souhaitez pas accepter cette invitation, vous pouvez simplement ignorer cet email.
      </p>

      <p style="margin: 16px 0 0; font-size: 14px; line-height: 1.6; color: #6b7280;">
        Si le bouton ne fonctionne pas, copiez-collez ce lien dans votre navigateur :<br>
        <a href="{{invitationLink}}" style="color: #3B82F6; word-break: break-all;">{{invitationLink}}</a>
      </p>
    </div>

    <!-- Footer -->
    <div style="padding: 24px 32px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">
      <p style="margin: 0; font-size: 14px; color: #6b7280; text-align: center;">
        © {{year}} Verebona. Tous droits réservés.
      </p>
    </div>
  </div>
</body>
</html>`,
    bodyText: `Invitation à rejoindre un compte

Bonjour,

{{inviterName}} vous invite à rejoindre le compte {{accountName}} sur Verebona avec le rôle {{role}}.

En rejoignant ce compte, vous aurez accès aux biens, documents et événements partagés par les membres du compte.

Accepter l'invitation : {{invitationLink}}

Si vous ne souhaitez pas accepter cette invitation, vous pouvez simplement ignorer cet email.

---
© {{year}} Verebona. Tous droits réservés.`,
    isActive: true,
    isSystem: true,
    variables: 'inviterName, accountName, role, invitationLink',
    category: 'account_membership',
  },
  {
    code: 'ACCOUNT_MEMBER_REMOVED',
    name: 'Retrait d\'un compte',
    subject: 'Vous avez été retiré du compte {{accountName}}',
    bodyHtml: `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Retrait d'un compte</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);">
    <!-- Header -->
    <div style="padding: 32px; text-align: center; border-bottom: 1px solid #e5e7eb;">
      <img src="{{logoUrl}}" alt="Verebona" style="height: 40px; width: auto;">
    </div>

    <!-- Body -->
    <div style="padding: 40px 32px;">
      <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #111827;">
        Retrait d'un compte
      </h1>

      <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #374151;">
        Bonjour {{memberName}},
      </p>

      <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #374151;">
        Vous avez été retiré du compte <strong>{{accountName}}</strong> par <strong>{{removedByName}}</strong>.
      </p>

      <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #374151;">
        Vous n'avez plus accès aux biens, documents et événements de ce compte.
      </p>

      <p style="margin: 24px 0 0; font-size: 14px; line-height: 1.6; color: #6b7280;">
        Si vous pensez qu'il s'agit d'une erreur, veuillez contacter le propriétaire du compte.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding: 24px 32px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">
      <p style="margin: 0; font-size: 14px; color: #6b7280; text-align: center;">
        © {{year}} Verebona. Tous droits réservés.
      </p>
    </div>
  </div>
</body>
</html>`,
    bodyText: `Retrait d'un compte

Bonjour {{memberName}},

Vous avez été retiré du compte {{accountName}} par {{removedByName}}.

Vous n'avez plus accès aux biens, documents et événements de ce compte.

Si vous pensez qu'il s'agit d'une erreur, veuillez contacter le propriétaire du compte.

---
© {{year}} Verebona. Tous droits réservés.`,
    isActive: true,
    isSystem: true,
    variables: 'memberName, accountName, removedByName',
    category: 'account_membership',
  },
  {
    code: 'MEMBER_REMOVED_DUE_TO_DOWNGRADE',
    name: 'Retrait automatique suite à un downgrade',
    subject: 'Votre accès au compte {{accountName}} a été retiré',
    bodyHtml: `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Retrait automatique d'un compte</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);">
    <!-- Header -->
    <div style="padding: 32px; text-align: center; border-bottom: 1px solid #e5e7eb;">
      <img src="{{logoUrl}}" alt="Verebona" style="height: 40px; width: auto;">
    </div>

    <!-- Body -->
    <div style="padding: 40px 32px;">
      <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #111827;">
        Modification de votre accès
      </h1>

      <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #374151;">
        Bonjour {{memberName}},
      </p>

      <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #374151;">
        Votre accès au compte <strong>{{accountName}}</strong> a été automatiquement retiré suite à un changement d'abonnement.
      </p>

      <div style="margin: 24px 0; padding: 16px; background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px;">
        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #92400e;">
          <strong>Raison :</strong><br>
          {{reason}}
        </p>
      </div>

      <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #374151;">
        Vous n'avez plus accès aux biens, documents et événements de ce compte. Si le propriétaire du compte décide de passer à une offre Premium permettant plusieurs membres, il pourra vous réinviter.
      </p>

      <p style="margin: 24px 0 0; font-size: 14px; line-height: 1.6; color: #6b7280;">
        Pour toute question, n'hésitez pas à contacter le propriétaire du compte.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding: 24px 32px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">
      <p style="margin: 0; font-size: 14px; color: #6b7280; text-align: center;">
        © {{year}} Verebona. Tous droits réservés.
      </p>
    </div>
  </div>
</body>
</html>`,
    bodyText: `Modification de votre accès

Bonjour {{memberName}},

Votre accès au compte {{accountName}} a été automatiquement retiré suite à un changement d'abonnement.

RAISON :
{{reason}}

Vous n'avez plus accès aux biens, documents et événements de ce compte. Si le propriétaire du compte décide de passer à une offre Premium permettant plusieurs membres, il pourra vous réinviter.

Pour toute question, n'hésitez pas à contacter le propriétaire du compte.

---
© {{year}} Verebona. Tous droits réservés.`,
    isActive: true,
    isSystem: true,
    variables: 'memberName, accountName, reason',
    category: 'account_membership',
  },
  {
    code: 'ACCOUNT_OWNERSHIP_TRANSFERRED',
    name: 'Transfert de propriété du compte',
    subject: 'Vous êtes maintenant propriétaire du compte {{accountName}}',
    bodyHtml: `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transfert de propriété</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);">
    <!-- Header -->
    <div style="padding: 32px; text-align: center; border-bottom: 1px solid #e5e7eb;">
      <img src="{{logoUrl}}" alt="Verebona" style="height: 40px; width: auto;">
    </div>

    <!-- Body -->
    <div style="padding: 40px 32px;">
      <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #111827;">
        Transfert de propriété
      </h1>

      <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #374151;">
        Bonjour {{newOwnerName}},
      </p>

      <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #374151;">
        <strong>{{previousOwnerName}}</strong> vous a transféré la propriété du compte <strong>{{accountName}}</strong>.
      </p>

      <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #374151;">
        En tant que propriétaire, vous avez maintenant tous les droits sur ce compte : gestion des membres, modification des paramètres, et gestion complète des données.
      </p>

      <div style="text-align: center; margin: 32px 0;">
        <a href="{{dashboardLink}}" style="display: inline-block; padding: 14px 28px; background-color: #3B82F6; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
          Accéder au compte
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding: 24px 32px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">
      <p style="margin: 0; font-size: 14px; color: #6b7280; text-align: center;">
        © {{year}} Verebona. Tous droits réservés.
      </p>
    </div>
  </div>
</body>
</html>`,
    bodyText: `Transfert de propriété

Bonjour {{newOwnerName}},

{{previousOwnerName}} vous a transféré la propriété du compte {{accountName}}.

En tant que propriétaire, vous avez maintenant tous les droits sur ce compte : gestion des membres, modification des paramètres, et gestion complète des données.

Accéder au compte : {{dashboardLink}}

---
© {{year}} Verebona. Tous droits réservés.`,
    isActive: true,
    isSystem: true,
    variables: 'newOwnerName, previousOwnerName, accountName, dashboardLink',
    category: 'account_membership',
  },
];

export async function seedAccountMembershipEmailTemplates() {
  
  for (const template of ACCOUNT_MEMBERSHIP_TEMPLATES) {
      try {
        // Vérifier si le template existe déjà
        const existing = await db
          .select()
          .from(emailTemplates)
          .where(eq(emailTemplates.type, template.code))
          .limit(1);

        if (existing.length > 0) {
          continue;
        }

        // Map code -> type pour le schema
        await db
            .insert(emailTemplates)
            .values({
          type: template.code,
          subject: template.subject,
          body: template.bodyHtml || template.bodyText,
          placeholders: template.variables || null,
          triggerConfig: null,
          sender: null,
          updatedAt: new Date(),
          updatedBy: null,
        })
            // Rejouable : appelé par /api/cron/seed à chaque amorçage.
            .onConflictDoUpdate({
                target: emailTemplates.type,
                set: {
          type: template.code,
          subject: template.subject,
          body: template.bodyHtml || template.bodyText,
          placeholders: template.variables || null,
          triggerConfig: null,
          sender: null,
          updatedAt: new Date(),
          updatedBy: null,
        },
            });

      } catch (error) {
        console.error(`  ❌ Failed to create template ${template.code}:`, error);
      }
  }

}

// Run if executed directly
if (require.main === module) {
  seedAccountMembershipEmailTemplates()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Failed to seed templates:', error);
      process.exit(1);
    });
}
