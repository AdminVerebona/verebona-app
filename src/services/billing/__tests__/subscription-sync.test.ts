import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// ── Base simulée ────────────────────────────────────────────────────────────
type Write = { op: 'update' | 'upsert' | 'insert'; table: unknown; values: Record<string, unknown> };
const state: {
  account: Record<string, unknown> | null;
  subRow: Record<string, unknown> | null;
  writes: Write[];
} = { account: null, subRow: null, writes: [] };

vi.mock('@/db', async () => {
  const schema = await import('@/db/schema');
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.accounts) return state.account ? [state.account] : [];
    if (table === schema.accountSubscriptions) return state.subRow ? [state.subRow] : [];
    if (table === schema.users) return [{ email: 'client@exemple.fr' }];
    if (table === schema.accountMemberships) return [{ userId: 3 }];
    return [];
  };
  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        const rows = rowsFor(table);
        return {
          limit: async () => rows,
          then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
        };
      },
    }),
  });
  const db: Record<string, unknown> = {
    select,
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { state.writes.push({ op: 'update', table, values }); },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          state.writes.push({ op: 'upsert', table, values: set });
        },
        then: (resolve: (v: unknown) => unknown) => {
          state.writes.push({ op: 'insert', table, values });
          return resolve(undefined);
        },
      }),
    }),
  };
  db.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db);
  return { db };
});

const markTrialConverted = vi.fn(async () => undefined);
vi.mock('@/services/trial.service', () => ({ markTrialConverted: (...a: unknown[]) => markTrialConverted(...(a as [])) }));

const sendPremiumConfirmationEmail = vi.fn(async () => undefined);
const sendDowngradeToStandardEmail = vi.fn(async () => undefined);
vi.mock('@/lib/email/billing-emails', () => ({
  sendPremiumConfirmationEmail: (...a: unknown[]) => sendPremiumConfirmationEmail(...(a as [])),
  sendDowngradeToStandardEmail: (...a: unknown[]) => sendDowngradeToStandardEmail(...(a as [])),
}));
const enforceStandardLimits = vi.fn(async () => undefined);
vi.mock('@/lib/plan-enforcement', () => ({
  enforceStandardLimits: (...a: unknown[]) => enforceStandardLimits(...(a as [])),
}));
vi.mock('@/services/document-ai/retroactive-analysis.service', () => ({
  scheduleRetroactiveAnalysis: vi.fn(async () => undefined),
}));

const fakeStripe = {
  checkout: { sessions: { retrieve: vi.fn() } },
  subscriptions: { retrieve: vi.fn() },
};
vi.mock('@/lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe')>()),
  getStripeServer: () => fakeStripe,
}));

import { accounts, accountSubscriptions, duoAccounts, subscriptionHistory, users } from '@/db/schema';
import {
  getInvoicePriceId,
  getInvoiceSubscriptionId,
  syncFromCheckoutSession,
  syncSubscriptionFromStripe,
} from '@/services/billing/subscription-sync.service';

// ── Fabriques ───────────────────────────────────────────────────────────────
const START = 1_780_000_000; // unix
const END = START + 365 * 86400;

function sub(overrides: Partial<Record<string, unknown>> = {}, priceId = 'price_prem_y'): Stripe.Subscription {
  return {
    id: 'sub_new',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    start_date: START,
    metadata: { accountId: '7' },
    items: {
      data: [{
        current_period_start: START,
        current_period_end: END,
        price: { id: priceId, recurring: { interval: 'year' } },
      }],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

const writesTo = (table: unknown) => state.writes.filter((w) => w.table === table);

beforeEach(() => {
  process.env.STRIPE_PRICE_PREMIUM_YEARLY = 'price_prem_y';
  process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_m';
  process.env.STRIPE_PRICE_PREMIUM_DUO_MONTHLY = 'price_duo_m';
  state.writes = [];
  state.subRow = { stripeSubscriptionId: null, firstBilledAt: null, contractConcludedAt: null };
  state.account = {
    id: 7, ownerUserId: 3, planType: 'STANDARD', subscriptionStatus: 'NONE',
    stripeCustomerId: 'cus_1', stripeSubscriptionId: null, subscriptionStartedAt: null,
    trialEndsAt: new Date('2026-09-18'), duoAccountId: null,
  };
  markTrialConverted.mockClear();
  sendPremiumConfirmationEmail.mockClear();
  sendDowngradeToStandardEmail.mockClear();
  enforceStandardLimits.mockClear();
  fakeStripe.checkout.sessions.retrieve.mockReset();
});

describe('syncSubscriptionFromStripe — paiement Premium annuel', () => {
  it('active le compte, l\'offre, la périodicité et les dates', async () => {
    const r = await syncSubscriptionFromStripe({ subscription: sub(), source: 'test' });

    expect(r).toMatchObject({
      accountId: 7, newPlanType: 'PREMIUM', newStatus: 'ACTIVE',
      billingPeriod: 'yearly', activated: true, isPaid: true,
    });

    const [acc] = writesTo(accounts);
    expect(acc.values).toMatchObject({
      planType: 'PREMIUM',
      subscriptionStatus: 'ACTIVE',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_new',
      premiumUntil: END,
      planRenewalDate: new Date(END * 1000),
      subscriptionStartedAt: new Date(START * 1000),
      trialEndsAt: null,
      checkoutSessionId: null,
    });

    const [row] = writesTo(accountSubscriptions);
    expect(row.values).toMatchObject({
      planCode: 'premium',
      status: 'active',
      billingPeriod: 'yearly',
      stripeSubscriptionId: 'sub_new',
      currentPeriodStartAt: new Date(START * 1000),
      currentPeriodEndAt: new Date(END * 1000),
      contractConcludedAt: new Date(START * 1000),
    });
    expect(row.values.firstBilledAt).toBeInstanceOf(Date);

    expect(writesTo(users)[0].values).toMatchObject({ planType: 'PREMIUM' });
    expect(markTrialConverted).toHaveBeenCalledTimes(1);

    // Effets de la transition : historique et email de confirmation.
    expect(writesTo(subscriptionHistory)[0].values).toMatchObject({
      oldTier: 'STANDARD', newTier: 'PREMIUM', newPremiumUntil: END, source: 'test',
    });
    expect(sendPremiumConfirmationEmail).toHaveBeenCalledWith(3, new Date(END * 1000));
  });

  it('ne rejoue pas les effets quand l\'état est déjà à jour (second chemin)', async () => {
    state.account = { ...state.account!, stripeSubscriptionId: 'sub_new', subscriptionStatus: 'ACTIVE', planType: 'PREMIUM' };
    await syncSubscriptionFromStripe({ subscription: sub(), source: 'webhook:customer.subscription.created' });
    expect(writesTo(subscriptionHistory)).toHaveLength(0);
    expect(sendPremiumConfirmationEmail).not.toHaveBeenCalled();
  });

  it('reste silencieuse côté client pour une resynchronisation admin', async () => {
    await syncSubscriptionFromStripe({ subscription: sub(), source: 'admin-resync', notify: false });
    expect(writesTo(subscriptionHistory)).toHaveLength(1);
    expect(sendPremiumConfirmationEmail).not.toHaveBeenCalled();
  });

  it('conserve la première facturation et la date de contrat déjà connues', async () => {
    const first = new Date('2026-01-01');
    const concluded = new Date('2026-01-01T10:00:00Z');
    state.subRow = { stripeSubscriptionId: 'sub_new', firstBilledAt: first, contractConcludedAt: concluded };
    state.account = { ...state.account!, stripeSubscriptionId: 'sub_new', subscriptionStatus: 'ACTIVE', planType: 'PREMIUM' };

    const r = await syncSubscriptionFromStripe({ subscription: sub(), source: 'test' });

    expect(r?.activated).toBe(false);
    expect(writesTo(accountSubscriptions)[0].values).toMatchObject({
      firstBilledAt: first,
      contractConcludedAt: concluded,
    });
    expect(markTrialConverted).not.toHaveBeenCalled();
  });

  it('reconnaît un prix mensuel V2', async () => {
    const r = await syncSubscriptionFromStripe({ subscription: sub({}, 'price_std_m'), source: 'test' });
    expect(r).toMatchObject({ newPlanType: 'STANDARD', billingPeriod: 'monthly', newStatus: 'ACTIVE' });
    expect(writesTo(accountSubscriptions)[0].values).toMatchObject({ planCode: 'standard', status: 'active' });
  });
});

describe('syncSubscriptionFromStripe — cas limites', () => {
  it('n\'accorde rien tant que le paiement est incomplet', async () => {
    const r = await syncSubscriptionFromStripe({ subscription: sub({ status: 'incomplete' }), source: 'test' });
    expect(r?.skipped).toBe('INCOMPLETE');
    expect(state.writes).toHaveLength(0);
  });

  it('ignore la fin d\'un ancien abonnement quand un autre est en place', async () => {
    state.account = { ...state.account!, stripeSubscriptionId: 'sub_actuel' };
    const r = await syncSubscriptionFromStripe({
      subscription: sub({ id: 'sub_ancien', status: 'canceled' }),
      source: 'test',
    });
    expect(r?.skipped).toBe('STALE_SUBSCRIPTION');
    expect(state.writes).toHaveLength(0);
  });

  it('repasse en Standard expiré à la fin de l\'abonnement courant', async () => {
    state.account = { ...state.account!, stripeSubscriptionId: 'sub_new', planType: 'PREMIUM', subscriptionStatus: 'ACTIVE' };
    const r = await syncSubscriptionFromStripe({ subscription: sub({ status: 'canceled' }), source: 'test' });
    expect(r).toMatchObject({ newPlanType: 'STANDARD', newStatus: 'EXPIRED', isPaid: false });
    expect(writesTo(accountSubscriptions)[0].values).toMatchObject({ status: 'canceled' });
    expect(writesTo(accounts)[0].values).toMatchObject({ premiumUntil: null, planRenewalDate: null });
    expect(sendDowngradeToStandardEmail).toHaveBeenCalledWith(3);
    expect(enforceStandardLimits).toHaveBeenCalledWith(7, 3);
  });

  it('garde l\'accès jusqu\'à l\'échéance d\'un abonnement résilié', async () => {
    const r = await syncSubscriptionFromStripe({ subscription: sub({ cancel_at_period_end: true }), source: 'test' });
    expect(r).toMatchObject({ newPlanType: 'PREMIUM', newStatus: 'CANCELED' });
    expect(writesTo(accountSubscriptions)[0].values).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
  });

  it('active le duo lié pour Premium Duo', async () => {
    const r = await syncSubscriptionFromStripe({
      subscription: sub({ metadata: { accountId: '7', duoId: '42' } }, 'price_duo_m'),
      source: 'test',
    });
    expect(r?.newPlanType).toBe('PREMIUM_DUO');
    expect(writesTo(accounts)[0].values).toMatchObject({ maxMembers: 2, duoAccountId: 42, subscriptionTier: 'pro' });
    expect(writesTo(duoAccounts)[0].values).toMatchObject({ stripeSubscriptionId: 'sub_new', subscriptionStatus: 'ACTIVE' });
  });

  it('refuse un prix inconnu', async () => {
    const r = await syncSubscriptionFromStripe({ subscription: sub({}, 'price_inconnu'), source: 'test' });
    expect(r).toBeNull();
    expect(state.writes).toHaveLength(0);
  });
});

describe('syncFromCheckoutSession', () => {
  it('refuse une session appartenant à un autre compte', async () => {
    fakeStripe.checkout.sessions.retrieve.mockResolvedValue({
      metadata: { accountId: '99' }, status: 'complete', subscription: sub(),
    });
    const r = await syncFromCheckoutSession({ sessionId: 'cs_x', accountId: 7 });
    expect(r).toEqual({ status: 'ignored', reason: 'NOT_OWNED' });
    expect(state.writes).toHaveLength(0);
  });

  it('ignore une session non terminée', async () => {
    fakeStripe.checkout.sessions.retrieve.mockResolvedValue({
      metadata: { accountId: '7' }, status: 'open', subscription: null,
    });
    expect(await syncFromCheckoutSession({ sessionId: 'cs_x', accountId: 7 }))
      .toEqual({ status: 'ignored', reason: 'NOT_COMPLETE' });
  });

  it('synchronise une session terminée du compte', async () => {
    fakeStripe.checkout.sessions.retrieve.mockResolvedValue({
      metadata: { accountId: '7' }, status: 'complete', subscription: sub(),
    });
    const r = await syncFromCheckoutSession({ sessionId: 'cs_x', accountId: 7 });
    expect(r.status).toBe('synced');
    expect(writesTo(accounts)[0].values).toMatchObject({ planType: 'PREMIUM', subscriptionStatus: 'ACTIVE' });
  });
});

describe('lecture des factures (API basil)', () => {
  it('trouve l\'abonnement sous parent.subscription_details', () => {
    const invoice = { parent: { subscription_details: { subscription: 'sub_1' } } } as unknown as Stripe.Invoice;
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_1');
  });

  it('accepte encore l\'ancien champ subscription', () => {
    const invoice = { parent: null, subscription: 'sub_legacy' } as unknown as Stripe.Invoice;
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_legacy');
  });

  it('lit le prix sous pricing.price_details', () => {
    const invoice = {
      lines: { data: [{ pricing: { price_details: { price: 'price_prem_y' } } }] },
    } as unknown as Stripe.Invoice;
    expect(getInvoicePriceId(invoice)).toBe('price_prem_y');
    expect(getInvoicePriceId({ lines: { data: [] } } as unknown as Stripe.Invoice)).toBeNull();
  });
});
