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
import { decideWithdrawalStatus, legacyLists, parseEntries, upsertRefund, type RefundEntry } from './refund-tracker';
import { getStripeServer } from '@/lib/stripe';
import { recordWithdrawalEvent } from './withdrawal-journal.service';

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

    // ══════════════════════════════════════════════════════════════════
    // SUIVI INDIVIDUEL, TOTAL RECALCULÉ (CDC §9.5)
    //
    // Chaque remboursement est une entrée (identifiant, montant, statut).
    // L'événement met à jour SON entrée — ignoré s'il est plus ancien que
    // celui déjà appliqué (ordre de livraison non garanti) —, puis le total
    // remboursé est RECALCULÉ depuis toutes les entrées réussies : un
    // webhook rejoué ne peut jamais l'augmenter une seconde fois.
    // ══════════════════════════════════════════════════════════════════
    let entries: RefundEntry[] = parseEntries(request.stripeRefundsJson);
    if (entries.length === 0 && request.stripeRefundIds) {
      // Demande antérieure au suivi individuel : reprise des listes.
      const ids: string[] = JSON.parse(request.stripeRefundIds || '[]');
      const sts: string[] = JSON.parse(request.stripeRefundStatuses || '[]');
      entries = ids.map((id, i) => ({ refundId: id, paymentId: null, amount: null, status: sts[i] ?? 'pending', eventCreated: null, updatedAt: null }));
    }
    const paymentId = typeof refund.payment_intent === 'string'
      ? refund.payment_intent
      : refund.payment_intent?.id ?? (typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? null);
    entries = upsertRefund(
      entries,
      { refundId: refund.id, paymentId, amount: refund.amount ?? null, status: refund.status ?? 'pending' },
      typeof event.created === 'number' ? event.created : null,
    );
    entries = await reconstructMissingAmounts(entries);

    const decision = decideWithdrawalStatus({
      cancellationStatus: request.cancellationStatus,
      entries,
      amountExpected: request.amountExpected ?? null,
    });
    const status = decision.status;
    const lists = legacyLists(entries);

    await db
      .update(withdrawalRequests)
      .set({
        stripeRefundsJson: entries as never,
        stripeRefundIds: lists.ids,
        stripeRefundStatuses: lists.statuses,
        // Total EXACT des remboursements réussis, recalculé.
        amountRefunded: decision.amountRefunded,
        status,
        ...(status === 'failed'
          ? {
              failureCode: decision.reason === 'AMOUNT_EXCEEDS_EXPECTED'
                ? 'REFUND_AMOUNT_INCONSISTENT'
                : `REFUND_${(refund.status ?? 'unknown').toUpperCase()}`,
              failureDetails:
                decision.reason === 'AMOUNT_EXCEEDS_EXPECTED'
                  ? `Remboursé ${decision.amountRefunded} > attendu ${request.amountExpected}.`
                  : refund.failure_reason ?? `Remboursement ${refund.id} en statut ${refund.status}.`,
            }
          : { failureCode: null, failureDetails: null }),
      })
      .where(eq(withdrawalRequests.publicReference, reference));

    await recordWithdrawalEvent({
      publicReference: reference,
      eventType: 'REFUND_STATUS_CHANGED',
      actor: 'stripe',
      result: status === 'failed' ? 'failure' : 'success',
      summary: `Remboursement ${refund.id} : ${refund.status} (événement ${event.type}).`,
      payload: {
        refundId: refund.id,
        status: refund.status,
        amount: refund.amount,
        eventType: event.type,
        eventId: event.id,
        failureReason: refund.failure_reason ?? null,
        amountRefunded: decision.amountRefunded,
        amountExpected: request.amountExpected ?? null,
      },
    });

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

    const decision = decideWithdrawalStatus({
      cancellationStatus: 'cancelled',
      entries: parseEntries(request.stripeRefundsJson),
      amountExpected: request.amountExpected ?? null,
    });
    const status = decision.status;

    await db
      .update(withdrawalRequests)
      .set({ cancellationStatus: 'cancelled', status, amountRefunded: decision.amountRefunded })
      .where(eq(withdrawalRequests.publicReference, request.publicReference));

    return { handled: true, publicReference: request.publicReference, status };
  } catch (e) {
    console.error('[withdrawal] annulation non enregistrée :', (e as Error).message);
    return { handled: false, detail: (e as Error).message };
  }
}

/**
 * Complète les montants inconnus (demandes antérieures au suivi individuel)
 * auprès de Stripe. Sans accès Stripe, l'entrée reste inconnue et la demande
 * ne peut pas être close — jamais de clôture sur un total supposé.
 */
async function reconstructMissingAmounts(entries: RefundEntry[]): Promise<RefundEntry[]> {
  if (!entries.some((e) => e.amount === null)) return entries;
  let stripe;
  try { stripe = getStripeServer(); } catch { return entries; }
  const out: RefundEntry[] = [];
  for (const e of entries) {
    if (e.amount !== null) { out.push(e); continue; }
    try {
      const r = await stripe.refunds.retrieve(e.refundId);
      out.push({ ...e, amount: r.amount ?? null });
    } catch {
      out.push(e);
    }
  }
  return out;
}
