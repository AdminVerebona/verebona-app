import { emailService } from './email-service';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/** Base absolue des liens (même règle que le service d'e-mail). */
const appUrl = (): string => (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://app.verebona.fr').replace(/\/+$/, '');

/**
 * Variables de la confirmation d'abonnement (gabarit PREMIUM_CONFIRMATION,
 * objet « Confirmation de votre abonnement Verebona Premium ») — pures.
 *
 * ⚠️ Le gabarit affiche `{{nextBillingDate}}` ; la date était transmise sous
 * le nom `premiumUntil`, que le gabarit ne connaît pas : « Prochaine
 * échéance » partait vide. Les deux noms sont transmis.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 81E — PLUS D'ENVOI « FIRE AND FORGET »
 *
 * La confirmation partait dans une promesse détachée, après que la
 * notification « Offre activée / modifiée » avait été marquée
 * `confirmationEmailSent: true` : un échec de l'envoi supprimait en silence
 * la confirmation contractuelle ET l'e-mail générique. Elle est désormais
 * enregistrée DURABLEMENT, une fois par opération, dans la transaction de la
 * transition (`subscription-communications.service`) et envoyée par la file
 * des lots 57A / 72F (`transactional-email-jobs.service`, type
 * PREMIUM_CONFIRMATION) avec les données contractuelles FIGÉES de
 * l'opération (offre, montant, périodicité, échéance).
 * ══════════════════════════════════════════════════════════════════════════
 */
export function premiumConfirmationVariables(
  firstName: string,
  nextBillingDate: Date,
  /**
   * Montant et périodicité de l'OPÉRATION concernée (prix contractuel lu sur
   * l'abonnement Stripe, CDC lookup_key LK-78) — jamais la grille courante.
   */
  details?: { planLabel?: string; unitAmountCents?: number | null; billingPeriod?: 'monthly' | 'yearly' | null },
): Record<string, string> {
  const formattedDate = formatBillingDate(nextBillingDate);
  return {
    firstName,
    nextBillingDate: formattedDate,
    // Ancien nom, conservé pour un gabarit personnalisé qui l'utiliserait.
    premiumUntil: formattedDate,
    ...confirmationDetails(details),
  };
}

/**
 * Variables de l'e-mail de fin d'offre (gabarit DOWNGRADE_NOTIFICATION :
 * « Votre offre Verebona a changé » — passage à une offre inférieure, jamais
 * présentation de Standard comme offre sans frais). Lot 81E : envoyé par la file DURABLE, une fois par
 * opération (type DOWNGRADE_NOTIFICATION).
 */
export function downgradeNotificationVariables(firstName: string): Record<string, string> {
  return {
    firstName,
    // Lot 70A : le gabarit en base affiche « Revoir mon offre : {{actionUrl}} ».
    actionUrl: `${appUrl()}/mon-compte/offres`,
  };
}

/** Variables d'offre, de montant et de périodicité (pures, LK-78). */
export function confirmationDetails(details?: { planLabel?: string; unitAmountCents?: number | null; billingPeriod?: 'monthly' | 'yearly' | null }): Record<string, string> {
  const eur = (c: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);
  const per = details?.billingPeriod === 'monthly' ? 'mois' : details?.billingPeriod === 'yearly' ? 'an' : null;
  return {
    planLabel: details?.planLabel ?? 'Premium',
    amountLabel: typeof details?.unitAmountCents === 'number' && per
      ? `${eur(details.unitAmountCents)} / ${per}, TTC, TVA incluse`
      : 'selon votre offre, TTC (voir votre facture)',
    periodLabel: details?.billingPeriod === 'monthly'
      ? 'Abonnement mensuel à reconduction tacite'
      : details?.billingPeriod === 'yearly' ? 'Abonnement annuel à reconduction tacite' : 'Abonnement à reconduction tacite',
  };
}

/** « 7 avril 2027 », fuseau de Paris (une échéance à 00:30 UTC reste le bon jour). */
export function formatBillingDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Paris',
  });
}

/**
 * Envoie un email à un membre retiré automatiquement suite à un downgrade
 */
export async function sendMemberRemovedDueToDowngradeEmail(
  memberUserId: number,
  accountName: string,
  reason: string
): Promise<void> {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, memberUserId))
      .limit(1);

    if (!user || !user.email) {
      throw new Error('User not found or has no email');
    }

    await emailService.send({
      templateCode: 'MEMBER_REMOVED_DUE_TO_DOWNGRADE',
      to: user.email,
      variables: {
        memberName: user.firstName,
        accountName: accountName,
        reason: reason,
      },
      userId: user.id,
    });

  } catch (error) {
    console.error('Error sending member removed due to downgrade email:', error);
    // Ne pas throw - l'email est secondaire
  }
}

/**
 * Envoie un email de confirmation de période d'essai (Trial)
 */
export async function sendTrialConfirmationEmail(
  userId: number,
  trialEndsAt: Date
): Promise<void> {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.email) {
      throw new Error('User not found or has no email');
    }

    const formattedDate = trialEndsAt.toLocaleDateString('fr-FR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    await emailService.send({
      templateCode: 'TRIAL_CONFIRMATION',
      to: user.email,
      variables: {
        firstName: user.firstName,
        trialEndsAt: formattedDate,
        // Lot 70A : « Accéder à Verebona : {{actionUrl}} » (gabarit en base) et
        // {{loginUrl}} (défaut du code) — jusqu'ici jamais fournis (lien mort).
        actionUrl: `${appUrl()}/dashboard`,
        loginUrl: `${appUrl()}/login`,
      },
      userId: user.id,
    });

  } catch (error) {
    console.error('Error sending trial confirmation email:', error);
    throw error;
  }
}
