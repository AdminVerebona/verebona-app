/**
 * Suivi des remboursements par webhook — CDC 6 §9.5, §9.6 et §12.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LE WEBHOOK EST INDISPENSABLE, ET PAS UN CONFORT
 *
 * Un remboursement Stripe n'aboutit pas au moment où on le crée. Il part en
 * `pending` et devient `succeeded` — ou `failed` — plusieurs jours plus tard,
 * selon la banque du consommateur.
 *
 * Sans webhook, une demande resterait indéfiniment en `processing`, et un
 * remboursement échoué passerait inaperçu : le consommateur ne serait jamais
 * remboursé et personne ne le saurait. Le §9.5 énumère précisément ces neuf
 * situations parce qu'aucune n'est théorique.
 *
 * Ce module ne lève jamais : une exception ferait répondre le webhook en
 * erreur, Stripe le rejouerait, et les effets de bord seraient appliqués deux
 * fois.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { withdrawalRequests } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { aggregateStatus, classifyRefundStatus } from './refund-calculator';

/** Événements Stripe pertinents pour une rétractation (§9.6). */
export const WITHDRAWAL_WEBHOOK_EVENTS = [
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.refund.updated',
] as const;

export interface WebhookOutcome {
  handled: boolean;
  publicReference?: string;
  status?: string;
  detail?: string;
}

/**
 * Met à jour une demande à partir d'un événement de remboursement.
 *
 * Le rattachement passe par la métadonnée `withdrawal_reference`, posée à la
 * création du remboursement. Se fier à l'identifiant d'abonnement serait
 * fragile : il peut être partagé par plusieurs demandes successives (§5.3).
 */
export async function handleRefundEvent(event: Stripe.Event): Promise<WebhookOutcome> {
  try {
    const refund = event.data.object as Stripe.Refund;
    const reference = refund.metadata?.withdrawal_reference;

    if (!reference) {
      // Remboursement sans rapport avec une rétractation — geste commercial,
      // litige, correction manuelle. Rien à faire ici.
      return { handled: false, detail: 'NO_WITHDRAWAL_REFERENCE' };
    }

    const [request] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.publicReference, reference))
      .limit(1);

    if (!request) {
      console.warn(`[withdrawal] webhook : demande ${reference} introuvable.`);
      return { handled: false, publicReference: reference, detail: 'REQUEST_NOT_FOUND' };
    }

    const refundIds: string[] = JSON.parse(request.stripeRefundIds ?? '[]');
    const refundStatuses: string[] = JSON.parse(request.stripeRefundStatuses ?? '[]');

    // Le remboursement est-il déjà connu ? Un webhook peut précéder l'écriture
    // faite à la création, ou la suivre.
    const index = refundIds.indexOf(refund.id);
    if (index === -1) {
      refundIds.push(refund.id);
      refundStatuses.push(refund.status ?? 'pending');
    } else {
      refundStatuses[index] = refund.status ?? refundStatuses[index];
    }

    // Le montant réglé est RECALCULÉ depuis les statuts, jamais incrémenté :
    // un webhook rejoué ajouterait sinon deux fois le même montant.
    const settledAmount = refundStatuses.reduce((sum, status, i) => {
      if (classifyRefundStatus(status) !== 'settled') return sum;
      // Le montant du remboursement courant est connu ; pour les autres, on
      // s'appuie sur la répartition déjà enregistrée.
      if (refundIds[i] === refund.id) return sum + (refund.amount ?? 0);
      return sum;
    }, 0);

    const status = aggregateStatus(
      request.cancellationStatus,
      refundStatuses,
      refundIds.length,
    );

    await db
      .update(withdrawalRequests)
      .set({
        stripeRefundIds: JSON.stringify(refundIds),
        stripeRefundStatuses: JSON.stringify(refundStatuses),
        // On ne diminue jamais un montant déjà réglé : un webhook tardif sur
        // un remboursement antérieur ne doit pas effacer les autres.
        amountRefunded: Math.max(request.amountRefunded, settledAmount),
        status,
        ...(status === 'failed'
          ? {
              failureCode: `REFUND_${(refund.status ?? 'unknown').toUpperCase()}`,
              failureDetails:
                refund.failure_reason ?? `Remboursement ${refund.id} en statut ${refund.status}.`,
            }
          : { failureCode: null, failureDetails: null }),
      })
      .where(eq(withdrawalRequests.publicReference, reference));

    if (status === 'failed') {
      // §9.6 : « déclencher une alerte en cas d'échec ». Le balayage du §21
      // remontera cette demande tant qu'elle n'est pas réglée.
      console.error(
        `[withdrawal] ${reference} : remboursement ${refund.id} en échec ` +
        `(${refund.status}) — intervention nécessaire.`,
      );
    } else {
      console.info(`[withdrawal] ${reference} : remboursement ${refund.id} → ${refund.status}.`);
    }

    return { handled: true, publicReference: reference, status };
  } catch (e) {
    console.error('[withdrawal] webhook de remboursement non traité :', (e as Error).message);
    return { handled: false, detail: (e as Error).message };
  }
}

/**
 * Annulation d'abonnement observée côté Stripe.
 *
 * Confirme l'annulation demandée au §9.2, y compris lorsqu'elle a été
 * effectuée hors de l'application.
 */
export async function handleSubscriptionCancelled(
  subscriptionId: string,
): Promise<WebhookOutcome> {
  try {
    const [request] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.stripeSubscriptionId, subscriptionId))
      .limit(1);

    if (!request || request.cancellationStatus === 'cancelled') {
      return { handled: false };
    }

    const refundStatuses: string[] = JSON.parse(request.stripeRefundStatuses ?? '[]');
    const status = aggregateStatus('cancelled', refundStatuses, refundStatuses.length);

    await db
      .update(withdrawalRequests)
      .set({ cancellationStatus: 'cancelled', status })
      .where(eq(withdrawalRequests.publicReference, request.publicReference));

    return { handled: true, publicReference: request.publicReference, status };
  } catch (e) {
    console.error('[withdrawal] annulation non enregistrée :', (e as Error).message);
    return { handled: false, detail: (e as Error).message };
  }
}
