// ⚠️ EN PREMIER : `@/db` lit DATABASE_URL au chargement du module.
import '@/lib/load-env';
import { db, ensureMigrations } from '@/db';
import { emailTemplates } from '@/db/schema';
import { inArray } from 'drizzle-orm';

/**
 * Accusé de réception de rétractation — CDC 6 §8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ENVOYÉ AVANT DE SAVOIR SI LE REMBOURSEMENT ABOUTIRA
 *
 * Le §8 le précise : « envoyé immédiatement après l'enregistrement de la
 * déclaration, sans attendre la réussite du remboursement ».
 *
 * C'est la conséquence directe du §7.4 : la déclaration est reçue dès qu'elle
 * est enregistrée. L'accusé atteste de cette réception — pas du bon
 * déroulement du traitement. Attendre Stripe pour l'envoyer reviendrait à
 * faire dépendre la preuve d'un droit exercé de la disponibilité d'un
 * prestataire.
 *
 * Le message annonce donc un remboursement « lancé », jamais « effectué ».
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Usage : npx tsx src/db/seeds/withdrawal/email_template_withdrawal.ts
 */

import { WITHDRAWAL_RECEIPT_HTML as WITHDRAWAL_RECEIPT_HTML_2026 } from '@/lib/email/email-html-templates';

const TYPE = 'WITHDRAWAL_RECEIPT';

/**
 * Lot 102A (décision PO du 31/10/2026) : accusé de réception. La rétractation
 * est traitée immédiatement : abonnement annulé, remboursement intégral lancé,
 * compte en lecture seule, données conservées `retentionDays` jours.
 * Même contenu que la migration 0901 (qui met à jour la base sans commande).
 */
export const WITHDRAWAL_RECEIPT_VARIABLES = [
  'firstName',
  'lastName',
  'publicReference',
  'requestedAtLabel',
  'contractLabel',
  'amountLabel',
  'retentionDays',
  'accountUrl',
  'legalPermalinkUrl',
  'contactEmail',
] as const;

export const WITHDRAWAL_RECEIPT_SUBJECT = 'Votre rétractation est enregistrée — {{publicReference}}';

/**
 * Lot 66C : corps à la charte « Sérénité » (lib/email/email-html-templates.ts). Le corps du lot 32,
 * inséré par la migration 0279, est mis à jour par la migration 0465 s'il n'a pas été personnalisé.
 * Lot 102A : compte en lecture seule et données conservées (plus de suppression immédiate) —
 * migration 0901.
 */
export const WITHDRAWAL_RECEIPT_HTML = WITHDRAWAL_RECEIPT_HTML_2026;

export async function seedWithdrawalEmailTemplate(): Promise<void> {
  await ensureMigrations();
  await db.delete(emailTemplates).where(inArray(emailTemplates.type, [TYPE]));
  await db.insert(emailTemplates).values({
    type: TYPE,
    subject: WITHDRAWAL_RECEIPT_SUBJECT,
    body: WITHDRAWAL_RECEIPT_HTML,
    placeholders: JSON.stringify(WITHDRAWAL_RECEIPT_VARIABLES),
  });
}

if (process.argv[1]?.includes('email_template_withdrawal')) {
  seedWithdrawalEmailTemplate()
    .then(() => {
      console.log(`[withdrawal] modèle ${TYPE} enregistré.`);
      process.exit(0);
    })
    .catch((e) => {
      const cause = (e as { cause?: { message?: string; code?: string } }).cause;
      console.error('[withdrawal] échec :', e.message);
      if (cause?.message) console.error(`[withdrawal] cause : ${cause.message}`);
      process.exit(1);
    });
}
