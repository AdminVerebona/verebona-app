/**
 * Registre des factures — CDC BO DOV-002 (CA encaissé), SUB-009/SUB-010.
 */
import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  buildInvoiceRecord,
  localInvoiceStatus,
  mergeInvoiceStatus,
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

  it('offre associée résolue depuis le prix du catalogue', () => {
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_m_test';
    const r = buildInvoiceRecord(invoice({
      lines: { data: [{ period: { start: 1, end: 2 }, pricing: { price_details: { price: 'price_premium_m_test' } } }] } as unknown as Stripe.ApiList<Stripe.InvoiceLineItem>,
    }));
    expect(r).toMatchObject({ planCode: 'premium', billingPeriod: 'monthly', stripePriceId: 'price_premium_m_test' });
  });
});
