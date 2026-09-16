import { describe, it, expect, vi, beforeEach } from 'vitest';

// Base simulée : on enregistre les tables mises à jour et les valeurs posées.
const updates: { table: unknown; values: Record<string, unknown> }[] = [];
vi.mock('@/db', () => ({
  db: {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { updates.push({ table, values }); },
      }),
    }),
  },
}));

import { accounts, accountSubscriptions, duoAccounts } from '@/db/schema';
import { ensureStripeCustomer, isStripeResourceMissing } from '@/lib/stripe-customer';

const missing = Object.assign(new Error('No such customer'), {
  type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404,
});

function fakeStripe(retrieve: () => Promise<unknown>) {
  return {
    customers: {
      retrieve: vi.fn(retrieve),
      create: vi.fn(async () => ({ id: 'cus_new' })),
    },
  } as any;
}

const base = { accountId: 7, userId: 3, email: 'a@b.fr', name: 'A B' };

beforeEach(() => { updates.length = 0; });

describe('ensureStripeCustomer', () => {
  it('réutilise un client valide sans rien écrire', async () => {
    const stripe = fakeStripe(async () => ({ id: 'cus_ok' }));
    const r = await ensureStripeCustomer({ ...base, stripe, storedCustomerId: 'cus_ok' });
    expect(r).toEqual({ customerId: 'cus_ok', created: false, replacedCustomerId: null });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('crée un client au premier paiement', async () => {
    const stripe = fakeStripe(async () => ({}));
    const r = await ensureStripeCustomer({ ...base, stripe, storedCustomerId: null });
    expect(r).toEqual({ customerId: 'cus_new', created: true, replacedCustomerId: null });
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(updates).toEqual([{ table: accounts, values: expect.objectContaining({ stripeCustomerId: 'cus_new' }) }]);
  });

  it('remplace un client introuvable dans le mode courant et purge les identifiants liés', async () => {
    const stripe = fakeStripe(async () => { throw missing; });
    const r = await ensureStripeCustomer({ ...base, stripe, storedCustomerId: 'cus_live' });
    expect(r).toEqual({ customerId: 'cus_new', created: true, replacedCustomerId: 'cus_live' });
    expect(stripe.customers.create.mock.calls[0][1]).toEqual({ idempotencyKey: 'verebona-customer-7-cus_live' });
    expect(updates.map((u) => u.table)).toEqual([accounts, accountSubscriptions, duoAccounts]);
    expect(updates[0].values).toMatchObject({
      stripeCustomerId: 'cus_new', stripeSubscriptionId: null, checkoutSessionId: null,
    });
  });

  it('remplace un client supprimé', async () => {
    const stripe = fakeStripe(async () => ({ id: 'cus_del', deleted: true }));
    const r = await ensureStripeCustomer({ ...base, stripe, storedCustomerId: 'cus_del' });
    expect(r.replacedCustomerId).toBe('cus_del');
  });

  it('propage les autres erreurs Stripe sans toucher la base', async () => {
    const stripe = fakeStripe(async () => { throw Object.assign(new Error('rate limit'), { code: 'rate_limit' }); });
    await expect(ensureStripeCustomer({ ...base, stripe, storedCustomerId: 'cus_x' })).rejects.toThrow('rate limit');
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

describe('isStripeResourceMissing', () => {
  it('ne reconnaît que les objets introuvables', () => {
    expect(isStripeResourceMissing(missing)).toBe(true);
    expect(isStripeResourceMissing(new Error('x'))).toBe(false);
    expect(isStripeResourceMissing(null)).toBe(false);
  });
});
