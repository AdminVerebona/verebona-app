/**
 * Une rétractation n'est close qu'une fois le montant attendu intégralement
 * remboursé ; chaque remboursement est suivi individuellement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let row: Record<string, unknown>;
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { row = { ...row, ...v }; } }) }),
  },
}));
vi.mock('../withdrawal-journal.service', () => ({ recordWithdrawalEvent: async () => {} }));
vi.mock('@/lib/stripe', () => ({ getStripeServer: () => ({ refunds: { retrieve: async (id: string) => ({ id, amount: 1000 }) } }) }));

const { handleRefundEvent } = await import('../withdrawal-webhook.service');
const { decideWithdrawalStatus, upsertRefund } = await import('../refund-tracker');

const REF = 'RET-20260901-ABCDEF';
const evt = (id: string, refund: { id: string; amount: number; status: string }, created: number) => ({
  id, type: 'refund.updated', created,
  data: { object: { ...refund, payment_intent: `pi_${refund.id}`, metadata: { withdrawal_reference: REF } } },
}) as never;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  row = {
    publicReference: REF, cancellationStatus: 'cancelled', amountExpected: 8000, amountRefunded: 0,
    stripeRefundsJson: [
      { refundId: 're_1', paymentId: 'pi_a', amount: 5000, status: 'pending', eventCreated: null, updatedAt: null },
      { refundId: 're_2', paymentId: 'pi_b', amount: 3000, status: 'pending', eventCreated: null, updatedAt: null },
    ],
    stripeRefundIds: '["re_1","re_2"]', stripeRefundStatuses: '["pending","pending"]', status: 'processing',
  };
});

describe('critère de recette : deux remboursements, succès dans le désordre', () => {
  it('le second d’abord → processing ; puis le premier → completed au montant exact', async () => {
    await handleRefundEvent(evt('evt_b', { id: 're_2', amount: 3000, status: 'succeeded' }, 100));
    expect(row).toMatchObject({ status: 'processing', amountRefunded: 3000 });

    await handleRefundEvent(evt('evt_a', { id: 're_1', amount: 5000, status: 'succeeded' }, 101));
    expect(row).toMatchObject({ status: 'completed', amountRefunded: 8000 });
    expect(row.stripeRefundIds).toBe('["re_1","re_2"]');
  });

  it('le même webhook rejoué plusieurs fois : le montant n’augmente jamais une seconde fois', async () => {
    for (let i = 0; i < 4; i++) await handleRefundEvent(evt('evt_b', { id: 're_2', amount: 3000, status: 'succeeded' }, 100));
    expect(row).toMatchObject({ status: 'processing', amountRefunded: 3000 });
  });

  it('un événement plus ancien arrivé après ne fait pas reculer le statut', async () => {
    await handleRefundEvent(evt('evt_new', { id: 're_1', amount: 5000, status: 'succeeded' }, 200));
    await handleRefundEvent(evt('evt_old', { id: 're_1', amount: 5000, status: 'pending' }, 150));
    const entry = (row.stripeRefundsJson as Array<{ refundId: string; status: string }>).find((e) => e.refundId === 're_1');
    expect(entry?.status).toBe('succeeded');
  });

  it('remboursement échoué → failed (anomalie)', async () => {
    await handleRefundEvent(evt('evt_f', { id: 're_1', amount: 5000, status: 'failed' }, 100));
    expect(row.status).toBe('failed');
  });
});

describe('règles de clôture', () => {
  const e = (amount: number | null, status: string, id = `re_${Math.random()}`) => ({ refundId: id, paymentId: null, amount, status, eventCreated: null, updatedAt: null });
  it('nombre correct mais montant insuffisant → processing', () => {
    expect(decideWithdrawalStatus({ cancellationStatus: 'cancelled', entries: [e(5000, 'succeeded'), e(2000, 'succeeded')], amountExpected: 8000 }).status).toBe('processing');
  });
  it('total supérieur à l’attendu → failed (incohérent)', () => {
    expect(decideWithdrawalStatus({ cancellationStatus: 'cancelled', entries: [e(9000, 'succeeded')], amountExpected: 8000 })).toMatchObject({ status: 'failed', reason: 'AMOUNT_EXCEEDS_EXPECTED' });
  });
  it('abonnement non annulé → jamais completed', () => {
    expect(decideWithdrawalStatus({ cancellationStatus: 'pending', entries: [e(8000, 'succeeded')], amountExpected: 8000 }).status).toBe('processing');
  });
  it('montant inconnu d’un remboursement réussi → pas de clôture', () => {
    expect(decideWithdrawalStatus({ cancellationStatus: 'cancelled', entries: [e(null, 'succeeded')], amountExpected: 8000 })).toMatchObject({ status: 'processing', reason: 'AMOUNT_UNKNOWN' });
  });
  it('upsert idempotent', () => {
    const a = upsertRefund([], { refundId: 're_x', amount: 100, status: 'pending' }, 10);
    const b = upsertRefund(a, { refundId: 're_x', amount: 100, status: 'succeeded' }, 11);
    expect(upsertRefund(b, { refundId: 're_x', amount: 100, status: 'succeeded' }, 11)).toHaveLength(1);
  });
});
