/**
 * Rétractation : identification fiable des paiements à rembourser (format
 * Stripe Basil, pagination, remboursements déjà faits, périmètre du contrat).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/services/account/scheduled-deletion.service', () => ({ scheduleDeletion: async () => ({}) }));
vi.mock('../withdrawal-journal.service', () => ({ recordWithdrawalEvent: async () => {} }));

const { listContractPayments } = await import('../withdrawal-processor.service');
const { buildRefundPlan } = await import('../refund-calculator');

const CONCLUDED = new Date('2026-01-01T00:00:00Z');
const REF = 'RET-20260901-ABCDEF';
const t = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const iter = <T,>(items: T[]) => (async function* () { for (const i of items) yield i; })();

/** Facture au format Basil : AUCUN champ payment_intent / charge. */
const invoice = (id: string, amountPaid: number) => ({ id, amount_paid: amountPaid, status: 'paid' });

function stripeFor(opts: {
  invoices: Array<{ id: string; amount_paid: number }>;
  charges: Record<string, Array<{ id: string; pi: string | null; amount: number; created: string }>>;
  refunds?: Record<string, Array<{ id: string; amount: number; status: string; ref?: string }>>;
}) {
  const charge = (c: { id: string; pi: string | null; amount: number; created: string }) => ({
    id: c.id, status: 'succeeded', paid: true, amount: c.amount, amount_captured: c.amount, amount_refunded: 0,
    currency: 'eur', created: t(c.created), disputed: false, payment_intent: c.pi,
  });
  return {
    invoices: { list: () => iter(opts.invoices) },
    invoicePayments: {
      list: ({ invoice: inv }: { invoice: string }) => iter((opts.charges[inv] ?? []).map((c) => ({
        id: `inpay_${c.id}`,
        payment: c.pi ? { type: 'payment_intent', payment_intent: { id: c.pi, latest_charge: charge(c) } } : { type: 'charge', charge: charge(c) },
      }))),
    },
    charges: { retrieve: async () => { throw new Error('non attendu'); } },
    paymentIntents: { retrieve: async () => { throw new Error('non attendu'); } },
    refunds: { list: ({ charge: ch }: { charge: string }) => iter((opts.refunds?.[ch] ?? []).map((r) => ({ id: r.id, amount: r.amount, status: r.status, metadata: r.ref ? { withdrawal_reference: r.ref } : {} }))) },
  } as never;
}

describe('facture réelle au format Basil', () => {
  it('le paiement initial est identifié (invoicePayments, pas invoice.payment_intent)', async () => {
    const stripe = stripeFor({ invoices: [invoice('in_1', 5900)], charges: { in_1: [{ id: 'ch_1', pi: 'pi_1', amount: 5900, created: '2026-01-01T00:00:10Z' }] } });
    const payments = await listContractPayments(stripe, 'sub_1', CONCLUDED, REF);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ id: 'pi_1', refundTarget: 'payment_intent', amount: 5900, amountRefunded: 0 });
    expect(buildRefundPlan(payments, CONCLUDED, REF).totalAmount).toBe(5900);
  });

  it('règlement sans PaymentIntent : remboursement sur la charge', async () => {
    const stripe = stripeFor({ invoices: [invoice('in_1', 290)], charges: { in_1: [{ id: 'ch_9', pi: null, amount: 290, created: '2026-02-01T00:00:00Z' }] } });
    const [p] = await listContractPayments(stripe, 'sub_1', CONCLUDED, REF);
    expect(p).toMatchObject({ id: 'ch_9', refundTarget: 'charge' });
  });
});

describe('plusieurs paiements, pagination, déductions', () => {
  it('contrat mensuel : tous les paiements depuis la conclusion, au-delà de 100 factures', async () => {
    const n = 150;
    const invoices = Array.from({ length: n }, (_, i) => invoice(`in_${i}`, 290));
    const charges = Object.fromEntries(invoices.map((inv, i) => [inv.id, [{ id: `ch_${i}`, pi: `pi_${i}`, amount: 290, created: new Date(CONCLUDED.getTime() + i * 3600_000).toISOString() }]]));
    const payments = await listContractPayments(stripeFor({ invoices, charges }), 'sub_1', CONCLUDED, REF);
    expect(payments).toHaveLength(150);
    expect(buildRefundPlan(payments, CONCLUDED, REF).totalAmount).toBe(150 * 290);
  });

  it('remboursements déjà réalisés déduits ; jamais plus que l’encaissé', async () => {
    const stripe = stripeFor({
      invoices: [invoice('in_1', 5900), invoice('in_2', 1000)],
      charges: { in_1: [{ id: 'ch_1', pi: 'pi_1', amount: 5900, created: '2026-01-02T00:00:00Z' }], in_2: [{ id: 'ch_2', pi: 'pi_2', amount: 1000, created: '2026-02-02T00:00:00Z' }] },
      refunds: { ch_1: [{ id: 're_geste', amount: 900, status: 'succeeded' }], ch_2: [{ id: 're_total', amount: 1000, status: 'succeeded' }] },
    });
    const payments = await listContractPayments(stripe, 'sub_1', CONCLUDED, REF);
    const plan = buildRefundPlan(payments, CONCLUDED, REF);
    expect(plan.totalAmount).toBe(5000);
    expect(plan.instructions).toEqual([expect.objectContaining({ paymentId: 'pi_1', amount: 5000 })]);
    expect(plan.excluded.map((e) => e.paymentId)).toEqual(['pi_2']);
    const encaisse = payments.reduce((s, p) => s + p.amount, 0);
    expect(plan.totalAmount).toBeLessThanOrEqual(encaisse);
  });

  it('reprise : ce que la demande a déjà demandé n’est pas redemandé', async () => {
    const stripe = stripeFor({
      invoices: [invoice('in_1', 5900)],
      charges: { in_1: [{ id: 'ch_1', pi: 'pi_1', amount: 5900, created: '2026-01-02T00:00:00Z' }] },
      refunds: { ch_1: [{ id: 're_own', amount: 5900, status: 'pending', ref: REF }] },
    });
    const plan = buildRefundPlan(await listContractPayments(stripe, 'sub_1', CONCLUDED, REF), CONCLUDED, REF);
    expect(plan.totalAmount).toBe(5900);        // attendu stable
    expect(plan.instructions).toEqual([]);       // rien à émettre de plus
  });

  it('paiement antérieur au contrat écarté', async () => {
    const stripe = stripeFor({ invoices: [invoice('in_old', 5900)], charges: { in_old: [{ id: 'ch_o', pi: 'pi_o', amount: 5900, created: '2025-06-01T00:00:00Z' }] } });
    const payments = await listContractPayments(stripe, 'sub_1', CONCLUDED, REF);
    expect(buildRefundPlan(payments, CONCLUDED, REF).totalAmount).toBe(0);
  });
});

describe('jamais « rien à rembourser » par défaut', () => {
  it('facture payée sans règlement identifiable → erreur (reprise), pas un montant nul', async () => {
    const stripe = stripeFor({ invoices: [invoice('in_1', 5900)], charges: {} });
    await expect(listContractPayments(stripe, 'sub_1', CONCLUDED, REF)).rejects.toThrow(/in_1/);
  });
  it('périmètre : seules les factures de l’abonnement rétracté sont lues', async () => {
    const list = vi.fn(() => iter([]));
    await listContractPayments({ invoices: { list } } as never, 'sub_1', CONCLUDED, REF);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ subscription: 'sub_1' }));
  });
});
