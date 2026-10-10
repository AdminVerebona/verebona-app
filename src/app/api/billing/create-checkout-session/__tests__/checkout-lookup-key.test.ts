/**
 * Route Checkout — CDC « Migration Stripe vers lookup_key » V4, §10
 * (LK-37 à LK-46) : validation stricte, titulaire seul, prix résolu et relu,
 * révision affichée, tentative unique, réutilisation sur le PRIX RÉEL,
 * quantité 1 (Duo), aucun essai Stripe, aucun état d'abonnement avant paiement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── Base simulée, par table ─────────────────────────────────────────────────
const tables = vi.hoisted(() => ({
  user: [{ id: 1, email: 'a@b.fr', firstName: 'A', lastName: 'B' }] as unknown[],
  memberships: [{ accountId: 10, role: 'owner' }] as unknown[],
  account: [{ id: 10, planType: 'STANDARD', stripeCustomerId: 'cus_1', stripeSubscriptionId: null, subscriptionStatus: 'NONE' }] as unknown[],
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
}));
vi.mock('@/db', async () => {
  const schema = await import('@/db/schema');
  const name = (t: unknown) => (t === schema.users ? 'users' : t === schema.accountMemberships ? 'memberships' : t === schema.accounts ? 'accounts' : t === schema.accountSubscriptions ? 'account_subscriptions' : 'other');
  const select = () => {
    let table = 'other';
    const c: Record<string, unknown> = {
      from: (t: unknown) => { table = name(t); return c; },
      where: () => c,
      limit: async () => (table === 'users' ? tables.user : table === 'accounts' ? tables.account : table === 'memberships' ? tables.memberships : []),
      then: (res: (v: unknown) => unknown) => Promise.resolve(table === 'memberships' ? tables.memberships : []).then(res),
    };
    return c;
  };
  return {
    db: {
      select,
      update: (t: unknown) => ({ set: (values: Record<string, unknown>) => { tables.updates.push({ table: name(t), values }); return { where: async () => undefined }; } }),
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined, returning: async () => [{ id: 77 }], then: (r: (v: unknown) => unknown) => Promise.resolve().then(r) }) }),
    },
  };
});
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: 1, currentAccountId: 10 }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/lib/stripe-customer', () => ({ ensureStripeCustomer: async () => ({ customerId: 'cus_1', replacedCustomerId: null }) }));
vi.mock('@/services/referral-attribution.service', () => ({
  normalizeReferralCode: (c: unknown) => (typeof c === 'string' ? c : null),
  getStoredReferralCode: async () => null,
  resolveReferralCode: async () => null,
}));
vi.mock('@/services/funnel-analytics.service', () => ({ trackFunnelEvent: async () => undefined }));
vi.mock('@/services/billing/pending-checkout.service', () => ({ PENDING_CHECKOUT_FIRST_CHECK_DELAY_MS: 120_000 }));

// ── Catalogue : prix résolus (révision active) ──────────────────────────────
const REV = 'pr_abcdefabcdefabcd';
const resolveCalls: Array<{ plan: string; period: string; forPayment: boolean }> = [];
vi.mock('@/services/billing/price-catalog.service', async () => {
  const { BillingCatalogError, toPublicOffer } = await import('@/services/billing/catalog-types');
  const fake = (plan: string, period: string) => ({
    planCode: plan, billingPeriod: period, lookupKey: `verebona_${plan}_${period}`, priceId: `price_${plan}_${period}_v4`, productId: `prod_${plan}`,
    unitAmountCents: period === 'yearly' ? 3900 : 390, currency: 'eur', interval: period === 'yearly' ? 'year' : 'month', intervalCount: 1,
    taxBehavior: 'inclusive', livemode: false, priceRevision: REV, verifiedAt: '2026-10-10T00:00:00Z',
  });
  return {
    resolveCurrentPrice: async (plan: string, period: string, o: { forPayment?: boolean }) => { resolveCalls.push({ plan, period, forPayment: Boolean(o?.forPayment) }); return fake(plan, period); },
    assertDisplayedRevision: (r: ReturnType<typeof fake>, d: string | null) => {
      if (!d) throw new BillingCatalogError('PRICE_CONFIRMATION_REQUIRED', undefined, toPublicOffer(r as never));
      if (d !== r.priceRevision) throw new BillingCatalogError('PRICE_CHANGED', undefined, toPublicOffer(r as never));
    },
  };
});

// ── Tentatives (état partagé) ───────────────────────────────────────────────
const ops = vi.hoisted(() => ({ open: null as null | { id: number; idempotencyKey: string; paramsHash: string; stripeReference: string | null; status: string }, n: 0, marks: [] as Array<[number, string, unknown]> }));
vi.mock('@/services/billing/price-operations.service', () => ({
  reserveCheckout: async (p: { price: { priceRevision: string; priceId: string } }) => {
    const hash = `${p.price.priceId}|${p.price.priceRevision}`;
    if (ops.open && ops.open.paramsHash === hash) return { kind: 'same', op: ops.open };
    const superseded = ops.open;
    ops.n++;
    ops.open = { id: ops.n, idempotencyKey: `vb-checkout.t.10.${hash}.${ops.n}`, paramsHash: hash, stripeReference: null, status: 'reserved' };
    return { kind: 'new', op: ops.open, superseded };
  },
  markOperation: async (id: number, status: string, patch: { stripeReference?: string }) => {
    ops.marks.push([id, status, patch]);
    if (ops.open?.id === id) {
      if (patch?.stripeReference) ops.open.stripeReference = patch.stripeReference;
      if (['expired', 'completed', 'failed', 'superseded'].includes(status)) ops.open = null;
    }
  },
}));

// ── Stripe ───────────────────────────────────────────────────────────────────
const stripe = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  lines: vi.fn(),
  expire: vi.fn(),
}));
vi.mock('@/lib/stripe', () => ({
  getStripeServer: () => ({ checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, listLineItems: stripe.lines, expire: stripe.expire } } }),
  StripeConfigError: class extends Error {},
}));

const { POST } = await import('../route');

function req(body: unknown) {
  return new NextRequest('https://app.test/api/billing/create-checkout-session', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  tables.memberships = [{ accountId: 10, role: 'owner' }];
  tables.account = [{ id: 10, planType: 'STANDARD', stripeCustomerId: 'cus_1', stripeSubscriptionId: null, subscriptionStatus: 'NONE' }];
  tables.updates.length = 0;
  ops.open = null; ops.n = 0; ops.marks.length = 0;
  resolveCalls.length = 0;
  stripe.create.mockReset().mockImplementation(async (p: unknown, o: { idempotencyKey: string }) => ({ id: `cs_${o.idempotencyKey.slice(-1)}`, url: 'https://checkout.stripe.com/x', params: p }));
  stripe.retrieve.mockReset();
  stripe.lines.mockReset();
  stripe.expire.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('validation stricte (LK-37, TC-09)', () => {
  it.each([
    [{ plan: 'gold', billing_period: 'monthly' }, 'INVALID_PLAN'],
    [{ plan: { x: 1 }, billing_period: 'monthly' }, 'INVALID_PLAN'],
    [{ billing_period: 'monthly' }, 'INVALID_PLAN'],
    [{ plan: 'premium' }, 'INVALID_BILLING_PERIOD'],
    [{ plan: 'premium', billing_period: 'weekly' }, 'INVALID_BILLING_PERIOD'],
  ])('TC-09 — %j → 400 %s, aucune opération Stripe', async (body, code) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(code);
    expect(stripe.create).not.toHaveBeenCalled();
    expect(resolveCalls).toHaveLength(0);
  });
});

describe('droit de souscrire (LK-38, TC-11)', () => {
  it('TC-11 — membre non titulaire (Duo) : 403 FORBIDDEN_BILLING_ACTION, aucune session', async () => {
    tables.memberships = [{ accountId: 10, role: 'member' }];
    const res = await POST(req({ plan: 'premium', billing_period: 'monthly', displayed_price_revision: REV }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_BILLING_ACTION');
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it('abonnement en cours : renvoi vers le changement d’offre (une seule logique d’upgrade, LK-46)', async () => {
    tables.account = [{ id: 10, planType: 'STANDARD', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', subscriptionStatus: 'ACTIVE' }];
    const res = await POST(req({ plan: 'premium_duo', billing_period: 'monthly', displayed_price_revision: REV }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('SUBSCRIPTION_CHANGE_REQUIRED');
    expect(stripe.create).not.toHaveBeenCalled();
  });
});

describe('prix et révision (LK-34, LK-39)', () => {
  it('TC-36 — révision absente : 409 PRICE_CONFIRMATION_REQUIRED avec le tarif, aucune session', async () => {
    const res = await POST(req({ plan: 'standard', billing_period: 'yearly' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'PRICE_CONFIRMATION_REQUIRED', offer: { unit_amount_cents: 3900, price_revision: REV } });
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it('TC-35 — révision différente : 409 PRICE_CHANGED et nouveau montant, aucune session', async () => {
    const res = await POST(req({ plan: 'standard', billing_period: 'yearly', displayed_price_revision: 'pr_0000000000000000' }));
    expect(res.status).toBe(409);
    expect((await res.json())).toMatchObject({ code: 'PRICE_CHANGED', message: "Le tarif a changé depuis l'affichage de cette page. Vérifiez le nouveau montant avant de continuer." });
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it('TC-29 / TC-10 / TC-37 — prix de Checkout = prix résolu et relu ; montant / price_id / lookup_key injectés ignorés ; quantité 1 ; aucun essai ; aucun état d’abonnement écrit', async () => {
    const res = await POST(req({
      plan: 'premium_duo', billing_period: 'yearly', displayed_price_revision: REV,
      price_id: 'price_pirate', amount: 1, lookup_key: 'verebona_standard_monthly', unit_amount: 1,
    }));
    expect(res.status).toBe(200);
    expect(resolveCalls).toEqual([{ plan: 'premium_duo', period: 'yearly', forPayment: true }]);
    const [params, opts] = stripe.create.mock.calls[0];
    expect(params.line_items).toEqual([{ price: 'price_premium_duo_yearly_v4', quantity: 1 }]);
    expect(JSON.stringify(params)).not.toMatch(/price_data|price_pirate|trial_period_days|trial_end/);
    expect(params.subscription_data.metadata).toMatchObject({ price_id: 'price_premium_duo_yearly_v4', price_revision: REV, planTier: 'premium_duo', billing_period: 'yearly' });
    expect(opts.idempotencyKey).toMatch(/^vb-checkout\./);
    // Aucun droit avant paiement : seul le client Stripe est rattaché.
    const subUpdates = tables.updates.filter((u) => u.table === 'account_subscriptions');
    expect(subUpdates.map((u) => Object.keys(u.values).sort())).toEqual([['stripeCustomerId', 'updatedAt']]);
    expect(tables.updates.some((u) => u.table === 'accounts' && 'planType' in u.values)).toBe(false);
  });
});

describe('tentative unique, réutilisation et réponse perdue (LK-42 à LK-45)', () => {
  const body = { plan: 'premium', billing_period: 'monthly', displayed_price_revision: REV };

  it('TC-30 — double clic : la session ouverte au MÊME prix est réutilisée, aucune seconde session', async () => {
    await POST(req(body));
    stripe.retrieve.mockResolvedValue({ id: 'cs_1', status: 'open', customer: 'cus_1', url: 'https://checkout.stripe.com/reuse', metadata: { accountId: '10', price_revision: REV } });
    stripe.lines.mockResolvedValue({ data: [{ price: { id: 'price_premium_monthly_v4' }, quantity: 1 }] });
    const res = await POST(req(body));
    expect((await res.json()).checkout_url).toBe('https://checkout.stripe.com/reuse');
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });

  it('TC-32 — session ouverte à un AUTRE prix réel (ancienne révision) : expirée, nouvelle tentative avec une nouvelle clé', async () => {
    await POST(req(body));
    stripe.retrieve.mockResolvedValue({ id: 'cs_1', status: 'open', customer: 'cus_1', url: 'u', metadata: { accountId: '10', price_revision: REV } });
    stripe.lines.mockResolvedValue({ data: [{ price: { id: 'price_premium_monthly_ANCIEN' }, quantity: 1 }] });
    await POST(req(body));
    expect(stripe.expire).toHaveBeenCalledWith('cs_1');
    expect(stripe.create).toHaveBeenCalledTimes(2);
    expect(stripe.create.mock.calls[1][1].idempotencyKey).not.toBe(stripe.create.mock.calls[0][1].idempotencyKey);
  });

  it('TC-34 — session déjà PAYÉE : aucune nouvelle création, vérification en cours', async () => {
    await POST(req(body));
    stripe.retrieve.mockResolvedValue({ id: 'cs_1', status: 'complete', customer: 'cus_1', metadata: { accountId: '10', price_revision: REV } });
    const res = await POST(req(body));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PAYMENT_VERIFICATION_IN_PROGRESS');
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });

  it('TC-31 — réponse Stripe perdue : tentative « incertaine », la relance rejoue la MÊME clé d’idempotence', async () => {
    stripe.create.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));
    const first = await POST(req(body));
    expect(first.status).toBe(503);
    expect(ops.marks.at(-1)?.[1]).toBe('uncertain');
    await POST(req(body));
    expect(stripe.create).toHaveBeenCalledTimes(2);
    expect(stripe.create.mock.calls[1][1].idempotencyKey).toBe(stripe.create.mock.calls[0][1].idempotencyKey);
  });
});
