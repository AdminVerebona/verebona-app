import { emailService } from './email-service';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Envoie un email de confirmation d'abonnement Premium
 */
export async function sendPremiumConfirmationEmail(
  userId: number,
  premiumUntil: Date
): Promise<void> {
  try {
    // Récupérer l'utilisateur
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.email) {
      throw new Error('User not found or has no email');
    }

    // Date lisible en français
    const formattedDate = premiumUntil.toLocaleDateString('fr-FR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const subject = 'Confirmation de votre abonnement Verebona Premium';
    
    const body = `Bonjour ${user.firstName},

Nous vous confirmons que votre abonnement Verebona Premium est maintenant actif.

📋 Détails de votre abonnement :
• Offre : Verebona Premium
• Montant : 59 € / an, TTC, TVA incluse
• Périodicité : Abonnement annuel à reconduction tacite
• Prochaine échéance : ${formattedDate}

Vous pouvez gérer ou résilier votre abonnement à tout moment depuis votre compte, via le portail de gestion Stripe ("Gérer mon abonnement").

À défaut de renouvellement, vous repasserez automatiquement à l'offre Standard gratuite.

Merci de votre confiance !

L'équipe Verebona`;

    await emailService.send({
      templateCode: 'PREMIUM_CONFIRMATION',
      to: user.email,
      variables: {
        firstName: user.firstName,
        premiumUntil: formattedDate,
      },
      userId: user.id,
    });

  } catch (error) {
    console.error('Error sending premium confirmation email:', error);
    throw error;
  }
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
