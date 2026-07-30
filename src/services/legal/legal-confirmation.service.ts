/**
 * Email de confirmation avec permalien — CDC 7 §10 et §18.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ÉCHEC D'ENVOI NE REMET RIEN EN CAUSE
 *
 * Le §18 est explicite : « l'acceptation reste valide si elle a été
 * correctement enregistrée ; l'email est retenté ; le lien reste visible dans
 * le compte ». Cette fonction ne lève donc jamais, et l'appelant n'a pas à
 * savoir si l'envoi a réussi pour poursuivre.
 *
 * L'échec est journalisé au sens du §19 (`CONFIRMATION_EMAIL_SENT`, résultat
 * `failure`), et l'utilisateur retrouve de toute façon son permalien dans
 * « Mon compte → Informations légales » — c'est la garantie que le scénario
 * R08 vérifie.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { emailService } from '@/lib/email/email-service';
import { recordLegalAudit } from './legal-audit.service';

export interface LegalConfirmationInput {
  to: string;
  userId: number;
  firstName: string;
  versionCode: string;
  permalink: string;
  /** Renseigné après une souscription payante (§10.2). */
  subscription?: {
    offerLabel: string;
    priceLabel: string;
    subscribedAtLabel: string;
    renewalLabel?: string;
  };
  /** Lien de rétractation, « lorsqu'il est applicable » (§10.2). */
  withdrawalUrl?: string;
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Construit le bloc « offre souscrite ».
 *
 * Le moteur de gabarits ne fait que substituer des variables : les blocs
 * conditionnels du §10.2 sont donc rendus ici, et valent chaîne vide lorsque
 * la section ne s'applique pas.
 */
function renderSubscriptionBlock(input: LegalConfirmationInput): string {
  const s = input.subscription;
  if (!s) return '';

  const renewal = s.renewalLabel
    ? `<p style="margin:0 0 4px;">Prochain renouvellement : ${s.renewalLabel}.</p>`
    : '';

  return `<p style="margin:0 0 4px;">Votre abonnement <strong>${s.offerLabel}</strong> a été souscrit le ${s.subscribedAtLabel}.</p>
<p style="margin:0 0 4px;">Prix : ${s.priceLabel}.</p>
${renewal}
<p style="margin:0 0 16px;"></p>`;
}

function renderWithdrawalBlock(input: LegalConfirmationInput): string {
  if (!input.withdrawalUrl) return '';
  return `<p style="margin:0 0 16px; font-size:13px; color:#555555;">
  Vous disposez d'un droit de rétractation :
  <a href="${input.withdrawalUrl}" style="color:#0b5fff;">renoncer au contrat</a>.
</p>`;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

/** Envoie la confirmation. Ne lève jamais. */
export async function sendLegalConfirmationEmail(
  input: LegalConfirmationInput,
): Promise<SendResult> {
  const permalinkUrl = input.permalink.startsWith('http')
    ? input.permalink
    : `${appBaseUrl()}${input.permalink}`;

  try {
    const result = await emailService.send({
      templateCode: 'LEGAL_CONFIRMATION',
      to: input.to,
      userId: input.userId,
      variables: {
        firstName: input.firstName,
        legalVersionCode: input.versionCode,
        legalPermalinkUrl: permalinkUrl,
        subscriptionBlockHtml: renderSubscriptionBlock(input),
        withdrawalBlockHtml: renderWithdrawalBlock(input),
        contactEmail: process.env.CONTACT_EMAIL || 'contact@verebona.fr',
      },
    });

    // §19 et §10.4 : l'identifiant de version envoyé est tracé, succès ou non.
    await recordLegalAudit({
      action: 'CONFIRMATION_EMAIL_SENT',
      actorUserId: input.userId,
      versionCode: input.versionCode,
      result: result.success ? 'success' : 'failure',
      details: result.success ? `destinataire ${input.to}` : result.error,
    });

    return result.success ? { sent: true } : { sent: false, error: result.error };
  } catch (e) {
    const message = (e as Error).message;
    await recordLegalAudit({
      action: 'CONFIRMATION_EMAIL_SENT',
      actorUserId: input.userId,
      versionCode: input.versionCode,
      result: 'failure',
      details: message,
    });
    console.error(`[legal] envoi de confirmation impossible à ${input.to} : ${message}`);
    return { sent: false, error: message };
  }
}
