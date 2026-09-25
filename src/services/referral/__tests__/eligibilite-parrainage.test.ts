/**
 * Mois offert au parrain : contrôle de l'état réel de la souscription et du
 * paiement du filleul au moment de l'attribution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let local: Record<string, unknown> | null;
let withdrawals: Array<{ status: string }>;
vi.mock('@/db', () => {
  let n = 0;
  const chain = () => {
    const i = n++;
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where']) c[m] = () => c;
    c.limit = async () => (i % 2 === 0 && local ? [local] : []);
    c.then = (r: (v: unknown) => unknown) => Promise.resolve(withdrawals).then(r);
    return c;
  };
  return { db: { select: () => chain() } };
});

const { checkReferralEligibility } = await import('../referral-eligibility.service');

function stripeWith(o: { sub?: Partial<{ status: string; interval: string; cancel_at_period_end: boolean; canceled_at: number | null }>; refunded?: number; disputed?: boolean; disputeStatus?: string; fail?: boolean }) {
  const charge = { id: 'ch_1', status: 'succeeded', paid: true, amount: 5900, amount_captured: 5900, amount_refunded: o.refunded ?? 0, currency: 'eur', created: 1_760_000_000, disputed: o.disputed ?? false, payment_intent: 'pi_1' };
  return {
    subscriptions: {
      retrieve: async () => {
        if (o.fail) throw new Error('Stripe indisponible');
        return { status: o.sub?.status ?? 'active', cancel_at_period_end: o.sub?.cancel_at_period_end ?? false, cancel_at: null, canceled_at: o.sub?.canceled_at ?? null, items: { data: [{ price: { recurring: { interval: o.sub?.interval ?? 'year' } } }] } };
      },
    },
    // Format Basil : les règlements de la facture, pas invoice.payment_intent.
    invoicePayments: { list: () => (async function* () { yield { id: 'inpay_1', payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', latest_charge: charge } } }; })() },
    charges: { retrieve: async () => charge },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', latest_charge: charge }) },
    disputes: { list: async () => ({ data: o.disputeStatus ? [{ status: o.disputeStatus }] : [] }) },
    invoices: { list: async () => ({ data: [] }) },
  } as never;
}
const event = { referredAccountId: 2, stripeInvoiceId: 'in_1', stripeSubscriptionId: 'sub_1' };

beforeEach(() => {
  local = { billingPeriod: 'yearly', status: 'active', cancelAtPeriodEnd: false, stripeSubscriptionId: 'sub_1' };
  withdrawals = [];
});

describe('critères de recette', () => {
  it('annuel valide, non remboursé, non contesté → cadeau attribué', async () => {
    expect(await checkReferralEligibility(stripeWith({}), event)).toEqual({ eligible: true });
  });
  it('paiement remboursé avant attribution → aucun cadeau (définitif)', async () => {
    expect(await checkReferralEligibility(stripeWith({ refunded: 5900 }), event)).toMatchObject({ eligible: false, reason: 'PAYMENT_REFUNDED', final: true });
  });
  it('remboursement partiel → aucun cadeau', async () => {
    expect((await checkReferralEligibility(stripeWith({ refunded: 100 }), event)).reason).toBe('PAYMENT_REFUNDED');
  });
  it('rétractation exercée → aucun cadeau, sans même interroger Stripe', async () => {
    withdrawals = [{ status: 'completed' }];
    expect(await checkReferralEligibility(stripeWith({ fail: true }), event)).toMatchObject({ reason: 'WITHDRAWAL_EXERCISED', final: true });
  });
  it('paiement contesté → aucun cadeau (en cours : report ; perdu : définitif)', async () => {
    expect(await checkReferralEligibility(stripeWith({ disputed: true, disputeStatus: 'needs_response' }), event)).toMatchObject({ reason: 'PAYMENT_DISPUTED', final: false });
    expect(await checkReferralEligibility(stripeWith({ disputed: true, disputeStatus: 'lost' }), event)).toMatchObject({ reason: 'PAYMENT_DISPUTED', final: true });
  });
  it('abonnement annuel résilié avant la date d’attribution → aucun cadeau', async () => {
    expect((await checkReferralEligibility(stripeWith({ sub: { cancel_at_period_end: true } }), event)).reason).toBe('SUBSCRIPTION_CANCELED');
    local!.cancelAtPeriodEnd = true;
    expect((await checkReferralEligibility(stripeWith({}), event)).reason).toBe('SUBSCRIPTION_CANCELED');
  });
  it('Stripe injoignable → pas d’attribution par défaut, report', async () => {
    expect(await checkReferralEligibility(stripeWith({ fail: true }), event)).toMatchObject({ eligible: false, reason: 'STRIPE_UNAVAILABLE', final: false });
  });
  it('passé en mensuel entre-temps → pas de cadeau', async () => {
    expect((await checkReferralEligibility(stripeWith({ sub: { interval: 'month' } }), event)).reason).toBe('NOT_YEARLY');
  });
});
