/**
 * Paiements encaissés d'une facture Stripe — format API 2025-08-27.basil.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `invoice.payment_intent` N'EXISTE PLUS
 *
 * Depuis l'API Basil, une facture ne porte plus `payment_intent` ni
 * `charge` : ses règlements sont des `InvoicePayment` (une facture peut en
 * avoir plusieurs), listés par `stripe.invoicePayments.list({ invoice })`.
 * Lire l'ancien champ rend `undefined`, et un code qui en conclut « aucun
 * paiement » se trompe en silence.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';

export interface PaidCharge {
  chargeId: string;
  paymentIntentId: string | null;
  invoiceId: string;
  /** Montant encaissé, en centimes. */
  amount: number;
  /** Montant déjà remboursé sur cette charge, en centimes. */
  amountRefunded: number;
  currency: string;
  created: Date;
  disputed: boolean;
}

export class PaymentLookupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PaymentLookupError';
  }
}

type StripeLike = Pick<Stripe, 'invoicePayments' | 'charges' | 'paymentIntents'>;

async function resolveCharge(stripe: StripeLike, p: Stripe.InvoicePayment): Promise<Stripe.Charge | null> {
  const pay = p.payment;
  if (pay.type === 'charge' && pay.charge) {
    return typeof pay.charge === 'string' ? stripe.charges.retrieve(pay.charge) : pay.charge;
  }
  if (pay.type === 'payment_intent' && pay.payment_intent) {
    const pi = typeof pay.payment_intent === 'string'
      ? await stripe.paymentIntents.retrieve(pay.payment_intent, { expand: ['latest_charge'] })
      : pay.payment_intent;
    const lc = pi.latest_charge;
    if (!lc) return null;
    return typeof lc === 'string' ? stripe.charges.retrieve(lc) : lc;
  }
  return null;
}

/**
 * Charges effectivement encaissées pour une facture (tous ses règlements
 * `paid`, pagination comprise). Lève si un règlement payé ne peut être relié
 * à une charge : mieux vaut une erreur qu'un montant faux.
 */
export async function listInvoicePaidCharges(stripe: StripeLike, invoiceId: string): Promise<PaidCharge[]> {
  const out: PaidCharge[] = [];
  for await (const p of stripe.invoicePayments.list({
    invoice: invoiceId,
    status: 'paid',
    limit: 100,
    expand: ['data.payment.payment_intent', 'data.payment.charge'],
  })) {
    const charge = await resolveCharge(stripe, p);
    if (!charge) {
      throw new PaymentLookupError(
        'CHARGE_NOT_FOUND',
        `Règlement ${p.id} de la facture ${invoiceId} payé sans charge identifiable.`,
      );
    }
    if (charge.status !== 'succeeded' || !charge.paid) continue;
    out.push({
      chargeId: charge.id,
      paymentIntentId: typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null,
      invoiceId,
      amount: charge.amount_captured ?? charge.amount,
      amountRefunded: charge.amount_refunded ?? 0,
      currency: charge.currency,
      created: new Date(charge.created * 1000),
      disputed: Boolean(charge.disputed),
    });
  }
  return out;
}
