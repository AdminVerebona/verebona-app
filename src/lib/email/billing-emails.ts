import { emailService } from './email-service';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Envoie l'email de confirmation d'abonnement (gabarit PREMIUM_CONFIRMATION,
 * objet « Confirmation de votre abonnement Verebona Premium »).
 *
 * ⚠️ Le gabarit affiche `{{nextBillingDate}}` ; la date était transmise sous
 * le nom `premiumUntil`, que le gabarit ne connaît pas : « Prochaine
 * échéance » partait vide. Les deux noms sont désormais transmis.
 *
 * C'est l'UNIQUE email de confirmation : la notification « Offre activée /
 * modifiée » qui l'accompagne n'envoie plus son propre email (« Votre
 * abonnement Verebona »), cf. `subscription-sync.service`.
 */
export async function sendPremiumConfirmationEmail(
  userId: number,
  nextBillingDate: Date
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

    const formattedDate = formatBillingDate(nextBillingDate);

    await emailService.send({
      templateCode: 'PREMIUM_CONFIRMATION',
      to: user.email,
      variables: {
        firstName: user.firstName ?? '',
        nextBillingDate: formattedDate,
        // Ancien nom, conservé pour un gabarit personnalisé qui l'utiliserait.
        premiumUntil: formattedDate,
      },
      userId: user.id,
    });

  } catch (error) {
    console.error('Error sending premium confirmation email:', error);
    throw error;
  }
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
 * Envoie un email de notification de downgrade vers Standard
 */
export async function sendDowngradeToStandardEmail(
  userId: number
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

    const subject = 'Votre abonnement Verebona Premium a été résilié';
    
    const body = `Bonjour ${user.firstName},

Votre abonnement Verebona Premium a été résilié.

Vous êtes désormais sur l'offre Standard gratuite de Verebona. Certaines fonctionnalités Premium ne sont plus accessibles, mais vous pouvez continuer à utiliser les fonctionnalités de base gratuitement.

Si vous souhaitez réactiver votre abonnement Premium, vous pouvez le faire à tout moment depuis votre page d'abonnement.

L'équipe Verebona`;

    await emailService.send({
      templateCode: 'DOWNGRADE_NOTIFICATION',
      to: user.email,
      variables: {
        firstName: user.firstName,
      },
      userId: user.id,
    });

  } catch (error) {
    console.error('Error sending downgrade email:', error);
    throw error;
  }
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
      },
      userId: user.id,
    });

  } catch (error) {
    console.error('Error sending trial confirmation email:', error);
    throw error;
  }
}
