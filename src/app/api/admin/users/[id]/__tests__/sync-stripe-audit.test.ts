/**
 * Resynchronisation Stripe depuis le BO : journalisée avec l'offre et le
 * statut avant / après — CDC Back-Office V1 AUD-001.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { accounts, users } from '@/db/schema';

/** Lignes renvoyées par table interrogée. */
let rowsByTable = new Map<unknown, unknown[]>();
function selectChain() {
  let table: unknown;
  const chain: Record<string, unknown> = {};
  chain.from = (t: unknown) => { table = t; return chain; };
  for (const m of ['where', 'limit']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rowsByTable.get(table) ?? []).then(res, rej);
  return chain;
}
vi.mock('@/db', () => ({ db: { select: () => selectChain() } }));
vi.mock('@/lib/auth-guards', () => ({ requireAdmin: async () => 1 }));
const logAdminAction = vi.fn(async (_entry: unknown) => {});
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (e: unknown) => logAdminAction(e) }));
const syncAccountFromStripeCustomer = vi.fn();
vi.mock('@/services/billing/subscription-sync.service', () => ({
  syncAccountFromStripeCustomer: (p: unknown) => syncAccountFromStripeCustomer(p),
}));
vi.mock('@/lib/stripe', () => ({ StripeConfigError: class StripeConfigError extends Error {} }));
vi.mock('@/lib/stripe-customer', () => ({ isStripeResourceMissing: () => false }));

const { POST } = await import('../sync-stripe/route');

const call = () => POST(
  new NextRequest('http://localhost/api/admin/users/7/sync-stripe', { method: 'POST' }),
  { params: Promise.resolve({ id: '7' }) },
);

const account = { id: 70, planType: 'STANDARD', subscriptionStatus: 'NONE', stripeCustomerId: 'cus_1' };

beforeEach(() => {
  rowsByTable = new Map<unknown, unknown[]>([[users, [{ id: 7 }]], [accounts, [account]]]);
  logAdminAction.mockClear();
  syncAccountFromStripeCustomer.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/admin/users/[id]/sync-stripe — journal AUD-001', () => {
  it('succès : journalise ACCOUNT_STRIPE_RESYNC avec anciennes et nouvelles valeurs', async () => {
    syncAccountFromStripeCustomer.mockResolvedValue({
      subscriptionCount: 1,
      result: {
        oldPlanType: 'STANDARD', newPlanType: 'PREMIUM',
        oldStatus: 'NONE', newStatus: 'ACTIVE',
        stripeStatus: 'active', billingPeriod: 'monthly', subscriptionId: 'sub_1',
      },
    });
    const r = await call();
    expect(r.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledTimes(1);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 1,
      action: 'ACCOUNT_STRIPE_RESYNC',
      targetType: 'ACCOUNT',
      targetId: 70,
      result: 'SUCCESS',
      before: { planType: 'STANDARD', subscriptionStatus: 'NONE' },
      after: { planType: 'PREMIUM', subscriptionStatus: 'ACTIVE' },
      details: expect.objectContaining({ userId: 7, changed: true }),
    }));
  });

  it('aucun abonnement synchronisable : journalisé FAILURE avec l’état avant', async () => {
    syncAccountFromStripeCustomer.mockResolvedValue({ result: null, subscriptionCount: 0 });
    const r = await call();
    expect(r.status).toBe(409);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ACCOUNT_STRIPE_RESYNC',
      targetId: 70,
      result: 'FAILURE',
      before: { planType: 'STANDARD', subscriptionStatus: 'NONE' },
      details: expect.objectContaining({ error: 'NO_STRIPE_SUBSCRIPTION' }),
    }));
  });

  it('erreur Stripe : journalisée FAILURE', async () => {
    syncAccountFromStripeCustomer.mockRejectedValue(new Error('boom'));
    const r = await call();
    expect(r.status).toBe(500);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ result: 'FAILURE', details: expect.objectContaining({ error: 'boom' }) }));
  });

  it('sans client Stripe : journalisé DENIED, aucune synchronisation', async () => {
    rowsByTable.set(accounts, [{ ...account, stripeCustomerId: null }]);
    const r = await call();
    expect(r.status).toBe(400);
    expect(syncAccountFromStripeCustomer).not.toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ result: 'DENIED', targetId: 70 }));
  });
});
