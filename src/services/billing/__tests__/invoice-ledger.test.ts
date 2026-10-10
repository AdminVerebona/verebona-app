/**
 * Registre des factures — CDC BO DOV-002 (CA encaissé), SUB-009/SUB-010.
 */
import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  attributeInvoicePlan,
  buildInvoiceRecord,
  localInvoiceStatus,
  mergeInvoiceStatus,
  type PriceResolutionMap,
} from '@/services/billing/invoice-ledger.service';

function invoice(over: Partial<Stripe.Invoice> & Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_1',
    customer: 'cus_1',
    status: 'open',
    attempted: false,
    attempt_count: 0,
    amount_due: 5900,
    amount_paid: 0,
    total: 5900,
    currency: 'EUR',
    billing_reason: 'subscription_cycle',
    status_transitions: { paid_at: null },
    parent: { subscription_details: { subscription: 'sub_1' } },
    lines: { data: [{ period: { start: 1780000000, end: 1811536000 }, pricing: { price_details: { price: 'price_unknown' } }, price: { recurring: { interval: 'year' } } }] },
    created: 1780000000,
    ...over,
  } as unknown as Stripe.Invoice;
}

describe('statut local', () => {
  it('facture payée, annulée, irrécouvrable', () => {
    expect(localInvoiceStatus({ status: 'paid', attempted: true, attempt_count: 1 })).toBe('paid');
    expect(localInvoiceStatus({ status: 'void', attempted: false, attempt_count: 0 })).toBe('void');
    expect(localInvoiceStatus({ status: 'uncollectible', attempted: true, attempt_count: 4 })).toBe('uncollectible');
  });

  it('échec de paiement identifié (SUB-010), facture Stripe restée « open »', () => {
    expect(localInvoiceStatus({ status: 'open', attempted: true, attempt_count: 1 }, 'invoice.payment_failed')).toBe('payment_failed');
    expect(localInvoiceStatus({ status: 'open', attempted: true, attempt_count: 2 }, 'invoice.updated')).toBe('payment_failed');
    expect(localInvoiceStatus({ status: 'open', attempted: false, attempt_count: 0 }, 'invoice.finalized')).toBe('open');
  });

  it('ne régresse jamais (événements dans le désordre)', () => {
    expect(mergeInvoiceStatus('paid', 'open')).toBe('paid');
    expect(mergeInvoiceStatus('paid', 'payment_failed')).toBe('paid');
    expect(mergeInvoiceStatus('payment_failed', 'open')).toBe('payment_failed');
    expect(mergeInvoiceStatus('payment_failed', 'paid')).toBe('paid');
    expect(mergeInvoiceStatus('uncollectible', 'paid')).toBe('paid');
    expect(mergeInvoiceStatus(null, 'open')).toBe('open');
  });
});

describe('buildInvoiceRecord', () => {
  it('facture payée : montant encaissé, date d’encaissement Stripe, devise en minuscules', () => {
    const r = buildInvoiceRecord(invoice({ status: 'paid', amount_paid: 5900, amount_due: 5900, status_transitions: { paid_at: 1780000100 } as Stripe.Invoice.StatusTransitions }));
    expect(r).toMatchObject({
      stripeInvoiceId: 'in_1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      amount: 5900,
      currency: 'eur',
      status: 'paid',
      billingReason: 'subscription_cycle',
      billingPeriod: 'yearly',
    });
    expect(r!.paidAt).toEqual(new Date(1780000100 * 1000));
  });

  it('échec : montant dû, date d’échec, pas de date d’encaissement', () => {
    const now = new Date('2026-09-26T00:00:00Z');
    const r = buildInvoiceRecord(invoice({ attempted: true, attempt_count: 1 }), { eventType: 'invoice.payment_failed', now });
    expect(r).toMatchObject({ status: 'payment_failed', amount: 5900, paidAt: null, lastPaymentFailedAt: now });
  });

  it('facture à 0 € ou sans client : ignorée', () => {
    expect(buildInvoiceRecord(invoice({ amount_due: 0, amount_paid: 0, total: 0 }))).toBeNull();
    expect(buildInvoiceRecord(invoice({ customer: null }))).toBeNull();
  });

  it('offre associée résolue depuis le registre historique (prérésolution, aucune variable d’environnement)', () => {
    const prices: PriceResolutionMap = new Map([['price_premium_m_test', { planCode: 'premium', billingPeriod: 'monthly' }]]);
    const r = buildInvoiceRecord(invoice({
      lines: { data: [{ amount: 590, period: { start: 1, end: 2 }, pricing: { price_details: { price: 'price_premium_m_test' } } }] } as unknown as Stripe.ApiList<Stripe.InvoiceLineItem>,
    }), { prices });
    expect(r).toMatchObject({ planCode: 'premium', billingPeriod: 'monthly', stripePriceId: 'price_premium_m_test', planResolution: 'single' });
  });

  it('TC-16 — un ancien prix 19/59/79 reconnu par le registre reste attribué (montant sans effet)', () => {
    const prices: PriceResolutionMap = new Map([['price_legacy_59', { planCode: 'premium', billingPeriod: 'yearly' }]]);
    const r = buildInvoiceRecord(invoice({ status: 'paid', amount_paid: 5900, lines: { data: [{ amount: 5900, period: { start: 1, end: 2 }, pricing: { price_details: { price: 'price_legacy_59' } } }] } as never }), { prices });
    expect(r).toMatchObject({ planCode: 'premium', billingPeriod: 'yearly', amount: 5900 });
  });
});

describe('TC-55 / LK-75 — facture à plusieurs lignes (changement d’offre)', () => {
  const prices: PriceResolutionMap = new Map([
    ['price_std_old', { planCode: 'standard', billingPeriod: 'yearly' }],
    ['price_pre_new', { planCode: 'premium', billingPeriod: 'yearly' }],
    ['price_duo_new', { planCode: 'premium_duo', billingPeriod: 'yearly' }],
  ]);
  const lines = (...l: Array<[string | null, number]>) => ({ data: l.map(([price, amount]) => ({ amount, period: { start: 1, end: 2 }, pricing: { price_details: { price } } })) }) as never;

  it('crédit sur l’ancien prix + charge sur le nouveau : offre de la CHARGE, détail conservé, montant encaissé inchangé', () => {
    const r = buildInvoiceRecord(invoice({ status: 'paid', amount_paid: 3100, lines: lines(['price_std_old', -2500], ['price_pre_new', 5600]) }), { prices })!;
    expect(r).toMatchObject({ planCode: 'premium', stripePriceId: 'price_pre_new', planResolution: 'charge_line', amount: 3100 });
    expect(r.lineItemsJson).toHaveLength(2);
    expect(r.lineItemsJson[0]).toMatchObject({ priceId: 'price_std_old', planCode: 'standard', amount: -2500 });
  });

  it('jamais la première ligne comme preuve : deux offres facturées positivement → offre NULL (multiple)', () => {
    const r = buildInvoiceRecord(invoice({ lines: lines(['price_pre_new', 100], ['price_duo_new', 200]) }), { prices })!;
    expect(r).toMatchObject({ planCode: null, planResolution: 'multiple' });
  });

  it('aucune ligne reconnue : offre inconnue (pas Standard par défaut)', () => {
    const r = buildInvoiceRecord(invoice({ lines: lines(['price_etranger', 100]) }), { prices })!;
    expect(r).toMatchObject({ planCode: null, planResolution: 'unknown' });
  });

  it('pagination : les lignes fournies (toutes pages) priment sur la première page de l’objet', () => {
    const r = buildInvoiceRecord(invoice({ lines: lines(['price_std_old', -2500]) }), {
      prices,
      lines: [
        { amount: -2500, period: { start: 1, end: 2 }, pricing: { price_details: { price: 'price_std_old' } } },
        { amount: 5600, period: { start: 1, end: 2 }, pricing: { price_details: { price: 'price_pre_new' } } },
      ] as never,
    })!;
    expect(r.planCode).toBe('premium');
    expect(r.lineItemsJson).toHaveLength(2);
  });

  it('attribution pure', () => {
    expect(attributeInvoicePlan([]).resolution).toBe('unknown');
  });
});
