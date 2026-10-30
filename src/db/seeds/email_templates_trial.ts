import { db } from '@/db';
import { emailTemplates } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { TRIAL_SHIPPED_TEMPLATES } from '@/services/trial-lifecycle/templates';

/**
 * Modeles de courriels de la sequence de fin d'essai (lot 100G, decision PO
 * « Questions PO 3 », E1 — textes repris mot pour mot) :
 *
 *   notif_trial_ending       J−2  notification de service (evenement TRIAL_ENDING)
 *   notif_trial_ended        J0   notification de service (evenement TRIAL_ENDED)
 *   TRIAL_FOLLOWUP_J3 … J60       relances commerciales (campagne distincte)
 *   TRIAL_DATA_RETENTION_J80      rappel conditionnel (envoi verrouille)
 *
 * Un seul circuit (E2) : les anciens modeles TRIAL_REMINDER_J3, TRIAL_REMINDER_J1
 * et TRIAL_ENDED ne sont plus amorces ni envoyes (retires, lot 100G).
 *
 * Usage : npx tsx src/db/seeds/email_templates_trial.ts
 * Rejouable : un modele absent est cree ; un modele present n'est jamais
 * ecrase (la migration 0887 livre les textes, l'editeur du BO les modifie).
 */
export async function seedTrialEmailTemplates() {
  console.log('\nModeles de courriels — sequence de fin d\'essai\n');
  for (const t of TRIAL_SHIPPED_TEMPLATES) {
    const existing = await db.select({ id: emailTemplates.id }).from(emailTemplates)
      .where(sql`upper(${emailTemplates.type}) = upper(${t.type})`).limit(1);
    if (existing.length) { console.log(`  present : ${t.type}`); continue; }
    await db.insert(emailTemplates).values({
      type: t.type,
      subject: t.subject,
      body: t.body,
      placeholders: JSON.stringify(t.placeholders),
      triggerConfig: null,
      sender: null,
      updatedAt: new Date(),
      updatedBy: null,
    }).onConflictDoNothing();
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
