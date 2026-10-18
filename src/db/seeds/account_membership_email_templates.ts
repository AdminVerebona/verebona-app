import { ACCOUNT_INVITATION_HTML, ACCOUNT_MEMBER_REMOVED_HTML, MEMBER_REMOVED_DUE_TO_DOWNGRADE_HTML, ACCOUNT_OWNERSHIP_TRANSFERRED_HTML } from '@/lib/email/email-html-templates';
import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { eq } from 'drizzle-orm';

const ACCOUNT_MEMBERSHIP_TEMPLATES = [
  {
    code: 'ACCOUNT_INVITATION',
    name: 'Invitation à rejoindre un compte',
    subject: 'Vous êtes invité à rejoindre {{accountName}} sur Verebona',
    bodyHtml: ACCOUNT_INVITATION_HTML,
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
    bodyHtml: ACCOUNT_MEMBER_REMOVED_HTML,
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
    bodyHtml: MEMBER_REMOVED_DUE_TO_DOWNGRADE_HTML,
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
    bodyHtml: ACCOUNT_OWNERSHIP_TRANSFERRED_HTML,
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
