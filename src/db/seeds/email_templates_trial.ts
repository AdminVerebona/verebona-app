import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { TRIAL_ENDED_HTML, TRIAL_REMINDER_J1_HTML, TRIAL_REMINDER_J3_HTML } from '@/lib/email/email-html-templates';

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

/** Lot 66C : corps HTML à la charte « Sérénité » 2026, partagés avec la migration 0465. */

const templates = [
  {
    type: 'TRIAL_REMINDER_J3',
    subject: 'Votre essai Verebona se termine dans {{daysRemaining}} jours',
    body: TRIAL_REMINDER_J3_HTML,
    placeholders: JSON.stringify(['firstName', 'daysRemaining', 'trialEndsAt', 'offersUrl']),
  },
  {
    type: 'TRIAL_REMINDER_J1',
    subject: 'Dernier jour de votre essai Verebona',
    body: TRIAL_REMINDER_J1_HTML,
    placeholders: JSON.stringify(['firstName', 'trialEndsAt', 'offersUrl']),
  },
  {
    type: 'TRIAL_ENDED',
    subject: 'Votre essai Verebona est termine',
    body: TRIAL_ENDED_HTML,
    placeholders: JSON.stringify(['firstName', 'offersUrl']),
  },
];

export async function seedTrialEmailTemplates() {
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

// ⚠️ Exécution CONDITIONNELLE : ce module est importable par /api/cron/seed.
// Sans cette garde, l'importer déclencherait l'amorçage à chaque démarrage.
if (process.argv[1]?.includes('email_templates_trial')) {
  seedTrialEmailTemplates()
    .then(() => process.exit(0))
    .catch((err: Error) => {
      console.error('[email_templates_trial] erreur :', err.message);
      process.exit(1);
    });
}
