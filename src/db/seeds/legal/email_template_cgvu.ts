// ⚠️ EN PREMIER : `@/db` lit DATABASE_URL au chargement du module.
import '@/lib/load-env';
import { db, ensureMigrations } from '@/db';
import { emailTemplates } from '@/db/schema';
import { inArray } from 'drizzle-orm';

/**
 * Modèle de courriel de confirmation avec permalien des CGVU — CDC 7 §10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE MESSAGE NE CONTIENT PAS LE TEXTE DES CGVU, ET C'EST LE POINT
 *
 * Le §1 et le §10.2 sont explicites : « éviter l'envoi d'un PDF ou du texte
 * intégral des CGVU dans l'email », « le texte complet des CGVU n'est pas
 * inséré dans l'email ». Le critère d'acceptation n°8 le vérifie.
 *
 * La confirmation sur support durable est assurée autrement : par un permalien
 * pointant vers une version figée, immuable et conservée sans date de purge
 * (§3.3, §3.4). C'est plus solide qu'une pièce jointe, qu'un client de
 * messagerie peut tronquer ou refuser.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Usage : npx tsx src/db/seeds/legal/email_template_cgvu.ts
 * Réexécutable : le modèle est remplacé à chaque passage.
 */

import { LEGAL_CONFIRMATION_HTML } from '@/lib/email/email-html-templates';

const TYPE = 'LEGAL_CONFIRMATION';

/**
 * Variables attendues à l'envoi.
 *
 * Les blocs conditionnels du §10.2 (« le cas échéant ») sont fournis en HTML
 * déjà rendu par l'appelant : le moteur de gabarits ne fait que substituer des
 * variables, il n'a pas de conditionnelle.
 */
export const LEGAL_CONFIRMATION_VARIABLES = [
  'firstName',
  'legalVersionCode',
  'legalPermalinkUrl',
  'subscriptionBlockHtml',
  'withdrawalBlockHtml',
  'contactEmail',
] as const;

const SUBJECT = 'Confirmation — vos conditions générales Verebona';

/** Lot 66C : corps à la charte « Sérénité » (lib/email/email-html-templates.ts, migration 0465). */
const HTML = LEGAL_CONFIRMATION_HTML;

export async function seedLegalEmailTemplate(): Promise<void> {
  // Script hors serveur Next : les migrations ne sont pas appliquées seules.
  await ensureMigrations();

  await db.delete(emailTemplates).where(inArray(emailTemplates.type, [TYPE]));

  await db.insert(emailTemplates).values({
    type: TYPE,
    subject: SUBJECT,
    body: HTML,
    placeholders: JSON.stringify(LEGAL_CONFIRMATION_VARIABLES),
  });
}

if (process.argv[1]?.includes('email_template_cgvu')) {
  seedLegalEmailTemplate()
    .then(() => {
      console.log(`[legal] modèle ${TYPE} enregistré.`);
      process.exit(0);
    })
    .catch((e) => {
      const cause = (e as { cause?: { message?: string; code?: string } }).cause;
      console.error('[legal] échec :', e.message);
      if (cause?.message) {
        console.error(`[legal] cause : ${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
      }
      process.exit(1);
    });
}
