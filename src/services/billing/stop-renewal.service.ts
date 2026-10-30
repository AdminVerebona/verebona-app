/**
 * Résiliation (fin de période) — lot 100D (décision PO A9 du 27/10/2026).
 *
 * Droit de l'utilisateur, CONSERVÉ dans l'application iOS / Android, où le
 * portail Stripe (achat, moyens de paiement) n'est pas proposé (lot 97B) :
 * l'abonnement n'est simplement plus renouvelé ; il reste actif jusqu'à la
 * fin de la période en cours, sans remboursement (ce n'est pas une
 * rétractation). Même effet que la résiliation du portail Verebona sur le Web
 * (configuration « fin de période », lot 70B) : le webhook Stripe reste la
 * source de vérité et envoie la confirmation SUBSCRIPTION_CANCELLATION_SCHEDULED.
 *
 * Réservé au titulaire de l'espace (contrôle de la route). Aucun prix, aucun
 * lien de paiement. Un abonnement en impayé (ou dans un autre état que
 * « actif » / « essai ») n'est pas résilié ici : ce cas se règle sur le site.
 */
import type Stripe from 'stripe';

export type StopRenewalOutcome =
  | { ok: true; alreadyScheduled: boolean; endsAt: string | null; subscriptionId: string }
  | { ok: false; code: 'NO_SUBSCRIPTION' | 'NOT_STOPPABLE_HERE' | 'BILLING_UNAVAILABLE'; message: string };

const STOPPABLE = new Set(['active', 'trialing']);

export const STOP_RENEWAL_MESSAGES = {
  NO_SUBSCRIPTION: 'Aucun abonnement en cours à résilier.',
  NOT_STOPPABLE_HERE: 'Cet abonnement ne peut pas être résilié depuis l’application. La gestion de l’abonnement se fait sur le site.',
  BILLING_UNAVAILABLE: 'La résiliation n’a pas pu être enregistrée. Réessayez dans quelques minutes.',
} as const;

function periodEnd(sub: Stripe.Subscription): string | null {
  const s = sub as unknown as { current_period_end?: number; cancel_at?: number | null; items?: { data?: Array<{ current_period_end?: number }> } };
  const t = s.cancel_at ?? s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null;
  return typeof t === 'number' ? new Date(t * 1000).toISOString() : null;
}

/** Programme la fin de l'abonnement `subscriptionId` à l'échéance (idempotent). */
export async function stopSubscriptionRenewal(
  subscriptionId: string | null | undefined,
  stripe: () => Pick<Stripe, 'subscriptions'>,
): Promise<StopRenewalOutcome> {
  if (!subscriptionId) return { ok: false, code: 'NO_SUBSCRIPTION', message: STOP_RENEWAL_MESSAGES.NO_SUBSCRIPTION };
  try {
    const client = stripe();
    const sub = await client.subscriptions.retrieve(subscriptionId);
    if (!STOPPABLE.has(sub.status)) {
      return { ok: false, code: 'NOT_STOPPABLE_HERE', message: STOP_RENEWAL_MESSAGES.NOT_STOPPABLE_HERE };
    }
    if (sub.cancel_at_period_end) return { ok: true, alreadyScheduled: true, endsAt: periodEnd(sub), subscriptionId };
    const updated = await client.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    return { ok: true, alreadyScheduled: false, endsAt: periodEnd(updated), subscriptionId };
  } catch (e) {
    const err = e as { code?: string; statusCode?: number };
    if (err?.code === 'resource_missing' || err?.statusCode === 404) {
      return { ok: false, code: 'NO_SUBSCRIPTION', message: STOP_RENEWAL_MESSAGES.NO_SUBSCRIPTION };
    }
    console.error('[stop-renewal] Stripe indisponible :', (e as Error)?.message ?? e);
    return { ok: false, code: 'BILLING_UNAVAILABLE', message: STOP_RENEWAL_MESSAGES.BILLING_UNAVAILABLE };
  }
}
