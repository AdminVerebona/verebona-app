/**
 * Changement exceptionnel d'offre — CDC Back-Office V1 ACC-A08 à ACC-A10,
 * ERR-005, REC-ACC-04 / REC-ACC-05.
 *
 * Stripe est simulé : on vérifie l'ORDRE (Stripe avant Verebona), les
 * paramètres (aucun prorata, échéance inchangée, périodicité conservée) et
 * l'absence de tout changement local en cas de refus Stripe.
 */
import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  buildStripeUpdateParams,
  billingPeriodOfPrice,
  changePlanAsAdmin,
  ADMIN_PLAN_CHANGE_HTTP_STATUS,
  type AdminPlanChangeDeps,
} from '@/services/billing/admin-plan-change.service';

type Snapshot = Awaited<ReturnType<AdminPlanChangeDeps['loadAccount']>>;

function makeDeps(opts: {
  snapshot?: Partial<NonNullable<Snapshot>> | null;
  subscription?: Partial<Stripe.Subscription>;
  updateError?: Error;
  interval?: 'month' | 'year';
}) {
  const calls: string[] = [];
  const snapshot: Snapshot = opts.snapshot === null ? null : {
    id: 1, ownerUserId: 10, planType: 'STANDARD', subscriptionStatus: 'ACTIVE', premiumUntil: null,
    stripeSubscriptionId: 'sub_1', billingPeriod: 'yearly', scheduledPlanCode: null,
    ...opts.snapshot,
  };
  const subscription = {
    id: 'sub_1',
    status: 'active',
    schedule: null,
    items: { data: [{ id: 'si_1', price: { recurring: { interval: opts.interval ?? 'year' } } }] },
    ...opts.subscription,
  } as unknown as Stripe.Subscription;
  const update = vi.fn(async () => {
    calls.push('stripe.update');
    if (opts.updateError) throw opts.updateError;
    return subscription;
  });
  const deps: AdminPlanChangeDeps = {
    loadAccount: async () => snapshot,
    stripe: () => ({
      subscriptions: {
        retrieve: vi.fn(async () => subscription),
        update,
      },
    }) as unknown as Pick<Stripe, 'subscriptions'>,
    applyLocal: vi.fn(async () => { calls.push('local'); }),
    resolvePrice: (plan, period) => `price_${plan}_${period}`,
  };
  return { deps, calls, update };
}

describe('paramètres Stripe (ACC-A09 / ACC-A10)', () => {
  it('aucun prorata, échéance inchangée', () => {
    const p = buildStripeUpdateParams('si_1', 'price_x');
    expect(p.proration_behavior).toBe('none');
    expect(p.billing_cycle_anchor).toBe('unchanged');
    expect(p.items).toEqual([{ id: 'si_1', price: 'price_x', quantity: 1 }]);
  });

  it('périodicité lue sur le prix Stripe', () => {
    expect(billingPeriodOfPrice({ recurring: { interval: 'month' } } as Stripe.Price)).toBe('monthly');
    expect(billingPeriodOfPrice({ recurring: { interval: 'year' } } as Stripe.Price)).toBe('yearly');
    expect(billingPeriodOfPrice(null)).toBeNull();
  });
});

describe('changePlanAsAdmin', () => {
  it('met Stripe à jour AVANT l’application locale, en conservant la périodicité', async () => {
    const { deps, calls, update } = makeDeps({ interval: 'month', snapshot: { billingPeriod: 'yearly' } });
    const res = await changePlanAsAdmin({ accountId: 1, newPlan: 'PREMIUM' }, deps);
    expect(res).toMatchObject({ ok: true, stripeUpdated: true, billingPeriod: 'monthly', oldPlan: 'STANDARD' });
    expect(calls).toEqual(['stripe.update', 'local']);
    expect(update).toHaveBeenCalledWith('sub_1', expect.objectContaining({
      items: [{ id: 'si_1', price: 'price_premium_monthly', quantity: 1 }],
      proration_behavior: 'none',
      billing_cycle_anchor: 'unchanged',
    }));
  });

  it('refus Stripe : 502 STRIPE_UPDATE_FAILED et AUCUN changement local (ERR-005)', async () => {
    const { deps, calls } = makeDeps({ updateError: new Error('card_declined') });
    const res = await changePlanAsAdmin({ accountId: 1, newPlan: 'PREMIUM_DUO' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('STRIPE_UPDATE_FAILED');
      expect(ADMIN_PLAN_CHANGE_HTTP_STATUS[res.code]).toBe(502);
    }
    expect(calls).toEqual(['stripe.update']);
    expect(deps.applyLocal).not.toHaveBeenCalled();
  });

  it('sans abonnement Stripe : changement local uniquement', async () => {
    const { deps, calls } = makeDeps({ snapshot: { stripeSubscriptionId: null } });
    const res = await changePlanAsAdmin({ accountId: 1, newPlan: 'PREMIUM' }, deps);
    expect(res).toMatchObject({ ok: true, stripeUpdated: false });
    expect(calls).toEqual(['local']);
  });

  it('abonnement Stripe terminé : changement local uniquement', async () => {
    const { deps, calls } = makeDeps({ subscription: { status: 'canceled' } });
    const res = await changePlanAsAdmin({ accountId: 1, newPlan: 'PREMIUM' }, deps);
    expect(res).toMatchObject({ ok: true, stripeUpdated: false });
    expect(calls).toEqual(['local']);
  });

  it('changement programmé en attente : refus explicite, rien n’est modifié', async () => {
    const { deps, calls } = makeDeps({ subscription: { schedule: 'sub_sched_1' as unknown as Stripe.SubscriptionSchedule } });
    const res = await changePlanAsAdmin({ accountId: 1, newPlan: 'PREMIUM' }, deps);
    expect(res).toMatchObject({ ok: false, code: 'SCHEDULED_CHANGE_PENDING' });
    expect(calls).toEqual([]);
  });

  it('même offre : refus sans appel Stripe', async () => {
    const { deps, calls } = makeDeps({ snapshot: { planType: 'PREMIUM' } });
    const res = await changePlanAsAdmin({ accountId: 1, newPlan: 'PREMIUM' }, deps);
    expect(res).toMatchObject({ ok: false, code: 'SAME_PLAN' });
    expect(calls).toEqual([]);
  });

  it('compte introuvable', async () => {
    const { deps } = makeDeps({ snapshot: null });
    expect(await changePlanAsAdmin({ accountId: 1, newPlan: 'PREMIUM' }, deps)).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND' });
  });
});
