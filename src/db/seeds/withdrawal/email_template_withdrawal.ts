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
 * Le message annonce donc un remboursement « en cours », jamais « effectué ».
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Usage : npx tsx src/db/seeds/withdrawal/email_template_withdrawal.ts
 */

const TYPE = 'WITHDRAWAL_RECEIPT';

export const WITHDRAWAL_RECEIPT_VARIABLES = [
  'firstName',
  'lastName',
  'publicReference',
  'requestedAtLabel',
  'contractLabel',
  'amountLabel',
  'dataExportDeadlineLabel',
  'trackingUrl',
  'legalPermalinkUrl',
  'contactEmail',
] as const;

const SUBJECT = 'Votre rétractation a bien été enregistrée — {{publicReference}}';

const HTML = `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Rétractation enregistrée</title>
  </head>
  <body style="margin:0; padding:0; background-color:#F5F5F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <center>
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5; padding:40px 0;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:12px; overflow:hidden;">

            <tr><td style="padding:32px 40px 8px;">
              <h1 style="margin:0; font-size:20px; color:#1a1a1a;">Verebona</h1>
            </td></tr>

            <tr><td style="padding:8px 40px 24px; color:#333333; font-size:15px; line-height:1.6;">
              <p style="margin:0 0 16px;">Bonjour {{firstName}} {{lastName}},</p>

              <p style="margin:0 0 16px;">
                Nous avons bien reçu votre déclaration de rétractation. Elle est
                enregistrée et prend effet immédiatement.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0"
                     style="background-color:#F7F9FB; border-radius:8px; margin:0 0 24px;">
                <tr><td style="padding:16px 20px; font-size:14px; color:#333333;">
                  <p style="margin:0 0 6px;"><strong>Référence :</strong> {{publicReference}}</p>
                  <p style="margin:0 0 6px;"><strong>Reçue le :</strong> {{requestedAtLabel}}</p>
                  <p style="margin:0 0 6px;"><strong>Contrat :</strong> {{contractLabel}}</p>
                  <p style="margin:0;"><strong>Remboursement prévu :</strong> {{amountLabel}}</p>
                </td></tr>
              </table>

              <p style="margin:0 0 8px;"><strong>Ce qui se passe maintenant</strong></p>
              <ul style="margin:0 0 16px; padding-left:20px;">
                <li style="margin:0 0 6px;">Votre abonnement est annulé : aucun nouveau prélèvement n'interviendra.</li>
                <li style="margin:0 0 6px;">Le remboursement est <strong>en cours de traitement</strong> sur votre moyen de paiement d'origine. Aucune retenue n'est appliquée.</li>
                <li style="margin:0 0 6px;">L'accès aux fonctions payantes est suspendu.</li>
                <li style="margin:0;">Vos données restent <strong>consultables et exportables jusqu'au {{dataExportDeadlineLabel}}</strong>.</li>
              </ul>

              <p style="margin:0 0 24px; font-size:14px; color:#555555;">
                Passé cette date, et sans nouvelle souscription de votre part, elles
                seront supprimées. Vous pouvez les exporter à tout moment depuis
                votre compte.
              </p>

              <p style="margin:0 0 24px;">
                <a href="{{trackingUrl}}"
                   style="display:inline-block; padding:12px 20px; background-color:#0b5fff; color:#ffffff; text-decoration:none; border-radius:6px; font-size:15px;">
                  Suivre ma demande
                </a>
              </p>

              <p style="margin:0 0 8px; font-size:13px; color:#555555;">
                Conditions générales applicables :
                <a href="{{legalPermalinkUrl}}" style="color:#0b5fff;">consulter</a>.
              </p>
              <p style="margin:0; font-size:13px; color:#555555;">
                Une question ? <a href="mailto:{{contactEmail}}" style="color:#0b5fff;">{{contactEmail}}</a>
              </p>
            </td></tr>

            <tr><td style="padding:16px 40px 32px; border-top:1px solid #eeeeee; font-size:12px; color:#888888;">
              Conservez ce message : il atteste de la date de votre déclaration.<br />
              Verebona — {{year}}
            </td></tr>

          </table>
        </td></tr>
      </table>
    </center>
  </body>
</html>`;

export async function seedWithdrawalEmailTemplate(): Promise<void> {
  await ensureMigrations();
  await db.delete(emailTemplates).where(inArray(emailTemplates.type, [TYPE]));
  await db.insert(emailTemplates).values({
    type: TYPE,
    subject: SUBJECT,
    body: HTML,
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
