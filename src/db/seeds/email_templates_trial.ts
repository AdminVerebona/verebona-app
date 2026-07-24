import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { inArray } from 'drizzle-orm';

/**
 * Modeles de courriels lies a l'essai gratuit (CDC tarification §14).
 *
 *   TRIAL_REMINDER_J3 — rappel a trois jours de la fin
 *   TRIAL_REMINDER_J1 — rappel la veille
 *   TRIAL_ENDED       — information de fin d'essai
 *
 * Chaque message rappelle explicitement, comme l'exige le cahier des charges :
 *   - qu'aucune carte bancaire n'a ete enregistree ;
 *   - qu'aucun prelevement automatique n'aura lieu ;
 *   - que les donnees restent conservees ;
 *   - qu'une offre doit etre choisie pour continuer.
 *
 * Usage : npx tsx src/db/seeds/email_templates_trial.ts
 * Le script est reexecutable : il remplace les trois modeles a chaque passage.
 */

const TYPES = ['TRIAL_REMINDER_J3', 'TRIAL_REMINDER_J1', 'TRIAL_ENDED'];

/** Gabarit HTML commun, sobre et compatible avec les clients de messagerie. */
function layout(title: string, intro: string, bodyHtml: string, ctaLabel: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#F5F5F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <center>
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5; padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:12px; overflow:hidden;">

              <tr>
                <td style="padding:32px 32px 8px;">
                  <h1 style="margin:0 0 16px; font-size:22px; font-weight:600; color:#0F1B33;">${title}</h1>
                  <p style="margin:0 0 16px; font-size:15px; line-height:1.6; color:#4B5563;">Bonjour {{firstName}},</p>
                  <p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:#4B5563;">${intro}</p>
                  ${bodyHtml}
                </td>
              </tr>

              <tr>
                <td align="center" style="padding:8px 32px 32px;">
                  <a href="{{offersUrl}}" style="display:inline-block; padding:13px 28px; border-radius:999px; background-color:#2563EB; color:#FFFFFF; font-size:15px; font-weight:600; text-decoration:none;">${ctaLabel}</a>
                </td>
              </tr>

              <tr>
                <td style="padding:20px 32px 28px; border-top:1px solid #E5E7EB;">
                  <p style="margin:0 0 6px; font-size:13px; line-height:1.6; color:#6B7280;">
                    Aucune carte bancaire n'a ete enregistree et aucun prelevement automatique n'aura lieu.
                  </p>
                  <p style="margin:0; font-size:13px; line-height:1.6; color:#6B7280;">
                    Vos donnees restent conservees. Pour continuer a ajouter et modifier vos biens et documents, il vous suffit de choisir une offre.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </center>
  </body>
</html>`;
}

const templates = [
  {
    type: 'TRIAL_REMINDER_J3',
    subject: 'Votre essai Verebona se termine dans {{daysRemaining}} jours',
    body: layout(
      'Plus que {{daysRemaining}} jours d\'essai',
      "Votre essai Premium se termine le {{trialEndsAt}}. D'ici la, vous continuez a profiter de l'ensemble des fonctionnalites : analyse automatique de vos documents, agenda de vos echeances, dossiers prets a utiliser et reponses a vos questions.",
      `<p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:#4B5563;">
         Si Verebona vous est utile, choisissez des maintenant l'offre qui vous convient — mensuelle ou annuelle, sans engagement.
       </p>`,
      'Voir les offres',
    ),
    placeholders: JSON.stringify(['firstName', 'daysRemaining', 'trialEndsAt', 'offersUrl']),
  },
  {
    type: 'TRIAL_REMINDER_J1',
    subject: 'Dernier jour de votre essai Verebona',
    body: layout(
      'Votre essai se termine demain',
      "Votre essai Premium prend fin le {{trialEndsAt}}. Passe cette date, l'ajout et la modification de vos biens et documents seront suspendus, mais vous garderez l'acces a tout ce que vous avez enregistre.",
      `<p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:#4B5563;">
         Pour continuer sans interruption, choisissez votre offre en quelques instants.
       </p>`,
      'Choisir mon abonnement',
    ),
    placeholders: JSON.stringify(['firstName', 'trialEndsAt', 'offersUrl']),
  },
  {
    type: 'TRIAL_ENDED',
    subject: 'Votre essai Verebona est termine',
    body: layout(
      'Votre essai gratuit est termine',
      "Votre essai Premium de 7 jours vient de s'achever. Vos biens, vos documents et vos echeances sont intacts et restent consultables.",
      `<p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:#4B5563;">
         Pour reprendre l'ajout et la modification, ainsi que les fonctionnalites Premium, choisissez l'offre adaptee a vos besoins. Trois formules sont disponibles, en paiement mensuel ou annuel.
       </p>`,
      'Decouvrir les offres',
    ),
    placeholders: JSON.stringify(['firstName', 'offersUrl']),
  },
];

async function main() {
  console.log('\nModeles de courriels — essai gratuit\n');

  // Remplacement integral : le script est rejouable sans creer de doublon.
  await db.delete(emailTemplates).where(inArray(emailTemplates.type, TYPES));

  for (const t of templates) {
    await db.insert(emailTemplates).values({
      type: t.type,
      subject: t.subject,
      body: t.body,
      placeholders: t.placeholders,
      triggerConfig: null,
      sender: null,
      updatedAt: new Date(),
      updatedBy: null,
    });
    console.log(`  cree : ${t.type}`);
  }

  console.log('\nTermine.\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[email_templates_trial] erreur :', err);
    process.exit(1);
  });
