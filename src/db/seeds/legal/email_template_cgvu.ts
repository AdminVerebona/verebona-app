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

const HTML = `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Confirmation Verebona</title>
  </head>
  <body style="margin:0; padding:0; background-color:#F5F5F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <center>
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5; padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:12px; overflow:hidden;">

              <tr>
                <td style="padding:32px 40px 8px;">
                  <h1 style="margin:0; font-size:20px; color:#1a1a1a;">Verebona</h1>
                </td>
              </tr>

              <tr>
                <td style="padding:8px 40px 24px; color:#333333; font-size:15px; line-height:1.6;">
                  <p style="margin:0 0 16px;">Bonjour {{firstName}},</p>

                  {{subscriptionBlockHtml}}

                  <p style="margin:0 0 8px;">
                    <strong>Conditions générales applicables :</strong>
                    version {{legalVersionCode}}.
                  </p>
                  <p style="margin:0 0 24px;">
                    Vous pouvez les consulter, les enregistrer ou les imprimer à tout
                    moment :
                  </p>

                  <p style="margin:0 0 24px;">
                    <a href="{{legalPermalinkUrl}}"
                       style="display:inline-block; padding:12px 20px; background-color:#0b5fff; color:#ffffff; text-decoration:none; border-radius:6px; font-size:15px;">
                      Consulter la version {{legalVersionCode}}
                    </a>
                  </p>

                  <p style="margin:0 0 24px; font-size:13px; color:#555555;">
                    Ce lien pointe vers la version exacte que vous avez acceptée. Elle
                    ne sera jamais modifiée et restera accessible, y compris si vous
                    fermez votre compte.
                  </p>

                  {{withdrawalBlockHtml}}

                  <p style="margin:0 0 8px; font-size:13px; color:#555555;">
                    Vous pouvez gérer votre abonnement depuis votre compte.
                  </p>
                  <p style="margin:0; font-size:13px; color:#555555;">
                    Une question ? Écrivez-nous à
                    <a href="mailto:{{contactEmail}}" style="color:#0b5fff;">{{contactEmail}}</a>.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:16px 40px 32px; border-top:1px solid #eeeeee; font-size:12px; color:#888888;">
                  Verebona — {{year}}
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </center>
  </body>
</html>`;

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
