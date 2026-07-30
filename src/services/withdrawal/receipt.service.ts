/**
 * Envoi de l'accusé de réception — CDC 6 §8 et §10.
 *
 * NE LÈVE JAMAIS. Le §10 le prévoit explicitement : « l'acceptation reste
 * valide si elle a été correctement enregistrée ; l'email est retenté ; le
 * lien reste visible dans le compte ». Un incident d'envoi ne peut pas
 * invalider une déclaration déjà écrite.
 */
import { emailService } from '@/lib/email/email-service';
import { markReceiptSent } from './withdrawal.service';
import type { WithdrawalSummary } from './summary.service';

export interface ReceiptInput {
  publicReference: string;
  to: string;
  userId: number;
  firstName: string;
  lastName: string;
  requestedAt: Date;
  summary: WithdrawalSummary;
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Horodatage affiché en heure de Paris, stocké en UTC (§7.4). */
function parisLabel(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

function parisDateLabel(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'long',
  }).format(new Date(iso));
}

export async function sendWithdrawalReceipt(input: ReceiptInput): Promise<{ sent: boolean }> {
  const base = appBaseUrl();

  try {
    const result = await emailService.send({
      templateCode: 'WITHDRAWAL_RECEIPT',
      to: input.to,
      userId: input.userId,
      variables: {
        firstName: input.firstName,
        lastName: input.lastName,
        publicReference: input.publicReference,
        requestedAtLabel: parisLabel(input.requestedAt),
        contractLabel: `${input.summary.offerLabel} — facturation ${input.summary.billingPeriodLabel}`,
        amountLabel: input.summary.amountLabel,
        dataExportDeadlineLabel: parisDateLabel(input.summary.dataDeletionAt),
        trackingUrl: `${base}/retractation/suivi/${input.publicReference}`,
        legalPermalinkUrl: `${base}/cgvu`,
        contactEmail: process.env.CONTACT_EMAIL || 'contact@verebona.fr',
      },
    });

    if (result.success) {
      await markReceiptSent(input.publicReference);
      return { sent: true };
    }

    console.error(
      `[withdrawal] accusé de réception non remis pour ${input.publicReference} : ${result.error}`,
    );
    return { sent: false };
  } catch (e) {
    console.error(
      `[withdrawal] envoi de l'accusé impossible pour ${input.publicReference} :`,
      (e as Error).message,
    );
    return { sent: false };
  }
}

/** Lien de vérification du parcours public (§6.3). */
export async function sendVerificationLink(input: {
  to: string;
  userId: number;
  firstName: string | null;
  token: string;
}): Promise<{ sent: boolean }> {
  const url = `${appBaseUrl()}/retractation?token=${encodeURIComponent(input.token)}`;
  try {
    const result = await emailService.send({
      templateCode: 'WITHDRAWAL_VERIFICATION',
      to: input.to,
      userId: input.userId,
      variables: {
        firstName: input.firstName ?? '',
        verificationUrl: url,
        contactEmail: process.env.CONTACT_EMAIL || 'contact@verebona.fr',
      },
    });
    return { sent: result.success };
  } catch (e) {
    console.error(`[withdrawal] lien de vérification non envoyé : ${(e as Error).message}`);
    return { sent: false };
  }
}
