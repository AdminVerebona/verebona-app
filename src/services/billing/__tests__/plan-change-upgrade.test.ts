/**
 * Changement d'offre (ticket « prise d'effet ») :
 *   - montée en gamme : immédiate, via Stripe (portail, prorata encaissé tout
 *     de suite), date d'échéance conservée ;
 *   - baisse de gamme : programmée à l'échéance, inscrite chez Stripe dans un
 *     échéancier pour que la facture de renouvellement soit au nouveau prix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Base : chaîne drizzle minimale, résultats pilotés par le test ─────────
let selectResults: unknown[][] = [];
const updates: unknown[] = [];
function chain(result: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) c[m] = () => c;
  c.limit = () => Promise.resolve(result());
  c.returning = () => Promise.resolve([{ id: 99 }]);
  c.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
  return c;
}
vi.mock('@/db', () => ({
  db: {
    select: () => chain(() => selectResults.shift() ?? []),
    update: () => ({ set: (v: unknown) => { updates.push(v); return { where: () => Promise.resolve() }; } }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 99 }]), then: (r: (v: unknown) => unknown) => Promise.resolve().then(r) }) }),
  },
}));

// ── Stripe ────────────────────────────────────────────────────────────────
const stripe = {
  subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  subscriptionSchedules: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn(), release: vi.fn() },
  billingPortal: {
    configurations: { list: vi.fn(), create: vi.fn() },
    sessions: { create: vi.fn() },
  },
  prices: { retrieve: vi.fn() },
};
vi.mock('@/lib/stripe', () => ({ getStripeServer: () => stripe }));

// ── Catalogue (CDC lookup_key V4) : prix résolus par la révision active ──
const PRICE_IDS: Record<string, Record<string, string>> = {
  standard: { monthly: 'price_std_m', yearly: 'price_std_y' },
  premium: { monthly: 'price_pre_m', yearly: 'price_pre_y' },
  premium_duo: { monthly: 'price_duo_m', yearly: 'price_duo_y' },
};
const REV = 'pr_1111111111111111';
const priceState = { unavailable: false };
function fakePrice(plan: string, period: string) {
  return {
    planCode: plan, billingPeriod: period, lookupKey: `verebona_${plan}_${period}`, priceId: PRICE_IDS[plan][period],
    productId: `prod_${plan}`, unitAmountCents: 100, currency: 'eur', interval: period === 'yearly' ? 'year' : 'month',
    intervalCount: 1, taxBehavior: 'inclusive', livemode: false, priceRevision: REV, verifiedAt: '2026-10-10T00:00:00Z',
  };
}
vi.mock('@/services/billing/price-catalog.service', async () => {
  const { BillingCatalogError, toPublicOffer } = await import('@/services/billing/catalog-types');
  return {
    resolveCurrentPrice: vi.fn(async (plan: string, period: string) => {
      if (priceState.unavailable) throw new BillingCatalogError('PRICE_UNAVAILABLE');
      return fakePrice(plan, period);
    }),
    assertDisplayedRevision: (resolved: ReturnType<typeof fakePrice>, displayed: string | null) => {
      if (!displayed) throw new BillingCatalogError('PRICE_CONFIRMATION_REQUIRED', undefined, toPublicOffer(resolved as never));
      if (displayed !== resolved.priceRevision) throw new BillingCatalogError('PRICE_CHANGED', undefined, toPublicOffer(resolved as never));
    },
  };
});
const portal = { ensure: vi.fn(async () => process.env.STRIPE_PORTAL_UPGRADE_CONFIGURATION_ID || 'bpc_aligned') };
vi.mock('@/services/billing/portal-configuration.service', () => ({
  ensureUpgradePortalConfiguration: () => portal.ensure(),
  PORTAL_CONFIG_METADATA_KEY: 'verebona_flow',
  PORTAL_CONFIG_METADATA_VALUE: 'immediate_upgrade_v1',
}));
const PLAN_OF: Record<string, [string, string]> = Object.fromEntries(
  Object.entries(PRICE_IDS).flatMap(([plan, m]) => Object.entries(m).map(([period, id]) => [id, [plan, period]])),
);
vi.mock('@/services/billing/price-history.service', () => ({
  primaryItem: async (sub: { items: { data: Array<{ price: { id: string } }> } }) => {
    const item = sub.items.data[0];
    const known = PLAN_OF[item?.price?.id];
    return known ? { item, result: { status: 'recognized', planCode: known[0], billingPeriod: known[1] } } : { error: 'NONE' };
  },
  resolveHistoricalPrice: async (id: string) => {
    const known = PLAN_OF[id];
    return known ? { status: 'recognized', priceId: id, planCode: known[0], billingPeriod: known[1] } : { status: 'unknown', priceId: id, reason: 'X' };
  },
}));
const operations = { record: vi.fn(async () => 1), pending: vi.fn(async () => null as unknown) };
vi.mock('@/services/billing/price-operations.service', () => ({
  recordPriceOperation: (...a: unknown[]) => operations.record(...(a as [])),
  pendingMutation: () => operations.pending(),
}));
const revaluation = { supersede: vi.fn(async () => 0) };
vi.mock('@/services/billing/price-revaluation.service', () => ({
  supersedeRevaluation: (...a: unknown[]) => revaluation.supersede(...(a as [])),
  isRevaluationSchedule: (s: { metadata?: Record<string, string> } | null) => Boolean(s?.metadata?.verebona_revaluation),
}));

const { isUpgrade } = await import('@/lib/stripe-prices');
const { startImmediateUpgrade } = await import('../plan-upgrade.service');
const { scheduleChange, applyScheduledChange, cancelScheduledChange, buildChangePhases } = await import('@/services/plan-change.service');

beforeEach(() => {
  selectResults = [];
  updates.length = 0;
  for (const group of Object.values(stripe)) {
    for (const fn of Object.values(group as Record<string, unknown>)) {
      if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
      else if (fn && typeof fn === 'object') for (const f of Object.values(fn)) (f as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  delete process.env.STRIPE_PORTAL_UPGRADE_CONFIGURATION_ID;
  priceState.unavailable = false;
  portal.ensure.mockClear();
  operations.record.mockClear();
  revaluation.supersede.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sens du changement', () => {
  it('Standard → Premium, Standard → Duo, Premium → Duo sont des montées en gamme', () => {
    expect(isUpgrade('standard', 'premium')).toBe(true);
    expect(isUpgrade('standard', 'premium_duo')).toBe(true);
    expect(isUpgrade('premium', 'premium_duo')).toBe(true);
  });
  it('les autres changements n’en sont pas', () => {
    expect(isUpgrade('premium', 'standard')).toBe(false);
    expect(isUpgrade('premium_duo', 'premium')).toBe(false);
    expect(isUpgrade('premium', 'premium')).toBe(false);
  });
});

describe('montée en gamme immédiate', () => {
  it('ouvre Stripe sur la confirmation du prorata, sans nouveau cycle', async () => {
    process.env.STRIPE_PORTAL_UPGRADE_CONFIGURATION_ID = 'bpc_upgrade';
    selectResults = [[{ planCode: 'standard', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', status: 'active', schedule: null, items: { data: [{ id: 'si_1', price: { id: 'price_std_m' } }] } });
    stripe.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/x' });

    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', appBaseUrl: 'https://app.test', displayedPriceRevision: REV });

    expect(r).toMatchObject({ ok: true, url: 'https://billing.stripe.com/p/session/x', scheduledChangeReleased: false });
    const params = stripe.billingPortal.sessions.create.mock.calls[0][0];
    expect(params.configuration).toBe('bpc_upgrade');
    expect(params.flow_data.type).toBe('subscription_update_confirm');
    expect(params.flow_data.subscription_update_confirm.items).toEqual([{ id: 'si_1', price: 'price_pre_m', quantity: 1 }]);
    expect(params.flow_data.after_completion.redirect.return_url).toBe('https://app.test/mon-compte/offres?changement=confirme');
    // Aucune modification directe de l'abonnement : Stripe la fait après paiement.
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('TC-41 — la configuration du portail est alignée sur la révision active AVANT l’ouverture', async () => {
    selectResults = [[{ planCode: 'standard', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', status: 'active', schedule: null, items: { data: [{ id: 'si_1', price: { id: 'price_std_m' } }] } });
    stripe.billingPortal.sessions.create.mockResolvedValue({ url: 'u' });

    await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', appBaseUrl: 'https://app.test', displayedPriceRevision: REV });

    expect(portal.ensure).toHaveBeenCalledTimes(1);
    expect(stripe.billingPortal.sessions.create.mock.calls[0][0].configuration).toBe('bpc_aligned');
    expect(operations.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'upgrade', previousPriceId: 'price_std_m' }));
  });

  it('abandonne une baisse programmée en base seulement (sinon le renouvellement annulerait la montée)', async () => {
    process.env.STRIPE_PORTAL_UPGRADE_CONFIGURATION_ID = 'bpc_upgrade';
    selectResults = [
      [{ planCode: 'premium', status: 'active', stripeSubscriptionId: 'sub_1', scheduledPlanCode: 'standard', stripeCustomerId: 'cus_1', ownerUserId: 5 }],
      [{ stripeSubscriptionId: 'sub_1' }], // lecture faite par cancelScheduledChange
      [{ id: 99 }],                         // compte Duo existant
    ];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', status: 'active', schedule: null, items: { data: [{ id: 'si_1', price: { id: 'price_pre_m' } }] } });
    stripe.billingPortal.sessions.create.mockResolvedValue({ url: 'u' });

    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium_duo', billingPeriod: 'monthly', appBaseUrl: 'x', displayedPriceRevision: REV });

    expect(r.ok).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({ scheduledPlanCode: null, scheduledBillingPeriod: null, scheduledChangeAt: null }));
  });

  it('refuse une baisse de gamme', async () => {
    selectResults = [[{ planCode: 'premium_duo', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'standard', billingPeriod: 'monthly', appBaseUrl: 'x', displayedPriceRevision: REV });
    expect(r).toEqual({ ok: false, reason: 'NOT_AN_UPGRADE' });
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});

describe('baisse de gamme programmée', () => {
  const periodEnd = new Date('2026-11-14T00:00:00Z');

  it('refuse de programmer une montée en gamme', async () => {
    selectResults = [[{ planCode: 'standard', billingPeriod: 'monthly', currentPeriodEndAt: periodEnd, stripeSubscriptionId: 'sub_1' }]];
    expect(await scheduleChange({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', displayedPriceRevision: REV }))
      .toEqual({ ok: false, reason: 'UPGRADE_IS_IMMEDIATE' });
  });

  it('inscrit la nouvelle offre chez Stripe pour la prochaine échéance, sans prorata', async () => {
    selectResults = [[{ planCode: 'premium', billingPeriod: 'monthly', currentPeriodEndAt: periodEnd, stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: null, items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_pre_m' } }] } });
    stripe.subscriptionSchedules.create.mockResolvedValue({ id: 'sub_sched_1' });
    const end = periodEnd.getTime() / 1000;
    stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sub_sched_1',
      current_phase: { start_date: 100, end_date: end },
      phases: [{ start_date: 100, end_date: end, items: [{ price: 'price_pre_m', quantity: 1 }], discounts: [] }],
    });

    const r = await scheduleChange({ accountId: 1, planCode: 'standard', billingPeriod: 'monthly', displayedPriceRevision: REV });

    expect(r).toMatchObject({ ok: true, effectiveAt: periodEnd });
    const [, upd] = stripe.subscriptionSchedules.update.mock.calls[0];
    expect(upd.end_behavior).toBe('release');
    expect(upd.phases[0]).toMatchObject({ start_date: 100, end_date: end, items: [{ price: 'price_pre_m', quantity: 1 }] });
    expect(upd.phases[1]).toMatchObject({ items: [{ price: 'price_std_m', quantity: 1 }], proration_behavior: 'none' });
  });

  it('au renouvellement, constate la bascule faite par Stripe sans refacturer', async () => {
    selectResults = [[{ scheduledPlanCode: 'standard', scheduledBillingPeriod: 'monthly', stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: 'sub_sched_1', items: { data: [{ id: 'si_1', price: { id: 'price_std_m' } }] } });

    const r = await applyScheduledChange(1);

    expect(r).toEqual({ applied: true, planCode: 'standard', billingPeriod: 'monthly' });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('une facture payée avant la bascule ne consomme pas le changement', async () => {
    selectResults = [[{ scheduledPlanCode: 'standard', scheduledBillingPeriod: 'monthly', stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: 'sub_sched_1', items: { data: [{ id: 'si_1', price: { id: 'price_pre_m' } }] } });
    expect(await applyScheduledChange(1)).toEqual({ applied: false, reason: 'NOT_YET_SWITCHED' });
  });

  it('aucun repli sur « la prochaine facture payée » : refus sans enregistrement si l’échéancier échoue', async () => {
    selectResults = [[{ planCode: 'premium', billingPeriod: 'monthly', currentPeriodEndAt: periodEnd, stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockRejectedValue(new Error('Stripe indisponible'));
    const r = await scheduleChange({ accountId: 1, planCode: 'premium', billingPeriod: 'yearly', displayedPriceRevision: REV });
    expect(r).toEqual({ ok: false, reason: 'STRIPE_SCHEDULE_FAILED' });
    expect(updates).toHaveLength(0);
  });

  it('même sans échéancier, la synchronisation ne modifie jamais l’abonnement Stripe', async () => {
    selectResults = [[{ scheduledPlanCode: 'premium', scheduledBillingPeriod: 'yearly', scheduledChangeAt: new Date('2020-01-01'), stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: null, items: { data: [{ id: 'si_1', price: { id: 'price_pre_m' } }] } });
    const r = await applyScheduledChange(1);
    expect(r).toMatchObject({ applied: false, reason: 'STRIPE_SCHEDULE_MISSING' });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('changement de périodicité (mensuel ↔ annuel)', () => {
  const periodEnd = new Date('2026-11-14T00:00:00Z');
  const end = periodEnd.getTime() / 1000;

  it('mensuel → annuel : période en cours conservée, facture de renouvellement au tarif annuel', async () => {
    selectResults = [[{ planCode: 'premium', billingPeriod: 'monthly', currentPeriodEndAt: new Date('2026-11-13T00:00:00Z'), stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: null, items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_pre_m' } }] } });
    stripe.subscriptionSchedules.create.mockResolvedValue({ id: 'sched' });
    stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched', current_phase: { start_date: 100, end_date: end },
      phases: [{ start_date: 100, end_date: end, items: [{ price: 'price_pre_m', quantity: 1 }], discounts: [] }],
    });

    const r = await scheduleChange({ accountId: 1, planCode: 'premium', billingPeriod: 'yearly', displayedPriceRevision: REV });

    // Date de bascule : celle de Stripe (fin de phase), enregistrée telle quelle.
    expect(r).toMatchObject({ ok: true, effectiveAt: periodEnd });
    expect(updates[0]).toMatchObject({ scheduledPlanCode: 'premium', scheduledBillingPeriod: 'yearly', scheduledChangeAt: periodEnd });
    const [, upd] = stripe.subscriptionSchedules.update.mock.calls[0];
    expect(upd.proration_behavior).toBe('none');
    expect(upd.phases[0]).toMatchObject({ end_date: end, items: [{ price: 'price_pre_m', quantity: 1 }] });
    expect(upd.phases[1]).toMatchObject({
      items: [{ price: 'price_pre_y', quantity: 1 }],
      duration: { interval: 'year', interval_count: 1 },
      proration_behavior: 'none',
    });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('annuel → mensuel : phase suivante mensuelle', async () => {
    selectResults = [[{ planCode: 'standard', billingPeriod: 'yearly', currentPeriodEndAt: periodEnd, stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: 'sched', items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_std_y' } }] } });
    stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched', current_phase: { start_date: 100, end_date: end },
      phases: [{ start_date: 100, end_date: end, items: [{ price: 'price_std_y', quantity: 1 }], discounts: [] }],
    });
    await scheduleChange({ accountId: 1, planCode: 'standard', billingPeriod: 'monthly', displayedPriceRevision: REV });
    // Échéancier existant réutilisé, pas de second échéancier.
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    const [, upd] = stripe.subscriptionSchedules.update.mock.calls[0];
    expect(upd.phases[1]).toMatchObject({ items: [{ price: 'price_std_m', quantity: 1 }], duration: { interval: 'month', interval_count: 1 } });
  });

  it('une facture intermédiaire ou de régularisation ne déclenche rien', async () => {
    for (const reason of ['subscription_update', 'manual', 'subscription_threshold', 'subscription_create']) {
      const r = await applyScheduledChange(1, new Date(), { invoiceBillingReason: reason });
      expect(r).toEqual({ applied: false, reason: 'NOT_A_RENEWAL_INVOICE' });
    }
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('facture de renouvellement au nouveau tarif : l’intention locale est effacée', async () => {
    selectResults = [[{ scheduledPlanCode: 'premium', scheduledBillingPeriod: 'yearly', scheduledChangeAt: periodEnd, stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: 'sched', items: { data: [{ id: 'si_1', price: { id: 'price_pre_y' } }] } });
    const r = await applyScheduledChange(1, new Date(), { invoiceBillingReason: 'subscription_cycle' });
    expect(r).toEqual({ applied: true, planCode: 'premium', billingPeriod: 'yearly' });
    expect(updates[0]).toMatchObject({ billingPeriod: 'yearly', scheduledPlanCode: null, scheduledChangeAt: null });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

// ── CDC « Migration Stripe vers lookup_key » V4 ────────────────────────────
describe('lookup_key — montée en gamme (LK-47 à LK-54)', () => {
  const sub = (price = 'price_std_m', schedule: unknown = null) => ({ id: 'sub_1', status: 'active', schedule, items: { data: [{ id: 'si_1', price: { id: price } }] } });

  it('TC-36 — révision affichée absente : 409 PRICE_CONFIRMATION_REQUIRED, rien n’est ouvert', async () => {
    selectResults = [[{ planCode: 'standard', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', appBaseUrl: 'x' });
    expect(r).toMatchObject({ ok: false, reason: 'PRICE_CONFIRMATION_REQUIRED' });
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('TC-35 — tarif changé entre affichage et clic : PRICE_CHANGED avec le nouveau tarif', async () => {
    selectResults = [[{ planCode: 'standard', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', appBaseUrl: 'x', displayedPriceRevision: 'pr_9999999999999999' });
    expect(r).toMatchObject({ ok: false, reason: 'PRICE_CHANGED', offer: { price_revision: REV, plan_code: 'premium' } });
  });

  it('TC-44 / LK-53 — prix indisponible alors qu’une baisse est programmée : la programmation n’est PAS libérée', async () => {
    priceState.unavailable = true;
    selectResults = [[{ planCode: 'premium', status: 'active', stripeSubscriptionId: 'sub_1', scheduledPlanCode: 'standard', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue(sub('price_pre_m', 'sched_1'));
    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium_duo', billingPeriod: 'monthly', appBaseUrl: 'x', displayedPriceRevision: REV });
    expect(r).toMatchObject({ ok: false, reason: 'PRICE_UNAVAILABLE' });
    expect(stripe.subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('TC-40 — upgrade depuis un ANCIEN prix reconnu : cible = prix courant, item principal reconnu', async () => {
    PLAN_OF_EXTRA('price_std_old_29', 'standard', 'yearly');
    selectResults = [[{ planCode: 'standard', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue(sub('price_std_old_29'));
    stripe.billingPortal.sessions.create.mockResolvedValue({ url: 'u' });
    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'yearly', appBaseUrl: 'x', displayedPriceRevision: REV });
    expect(r.ok).toBe(true);
    expect(stripe.billingPortal.sessions.create.mock.calls[0][0].flow_data.subscription_update_confirm.items).toEqual([{ id: 'si_1', price: 'price_pre_y', quantity: 1 }]);
  });

  it('LK-73 — item non reconnu : refus avant toute libération ou ouverture', async () => {
    selectResults = [[{ planCode: 'standard', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue(sub('price_etranger'));
    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', appBaseUrl: 'x', displayedPriceRevision: REV });
    expect(r).toMatchObject({ ok: false, reason: 'UNRECOGNIZED_SUBSCRIPTION_ITEM' });
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('LK-54 — mutation déjà en cours sur le compte : refus', async () => {
    operations.pending.mockResolvedValueOnce({ id: 9 });
    selectResults = [[{ planCode: 'standard', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue(sub());
    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', appBaseUrl: 'x', displayedPriceRevision: REV });
    expect(r).toMatchObject({ ok: false, reason: 'MUTATION_IN_PROGRESS' });
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(stripe.subscriptionSchedules.release).not.toHaveBeenCalled();
  });
});

describe('lookup_key — changements programmés (LK-55 à LK-59)', () => {
  const end = new Date('2026-11-14T00:00:00Z').getTime() / 1000;

  it('TC-47 / TC-49 — le prix EXACT accepté est enregistré (phase future ET miroir local)', async () => {
    selectResults = [[{ planCode: 'premium', billingPeriod: 'monthly', currentPeriodEndAt: new Date(end * 1000), stripeSubscriptionId: 'sub_1', stripePriceId: 'price_pre_m', contractUnitAmountCents: 590 }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: null, items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_pre_m' } }] } });
    stripe.subscriptionSchedules.create.mockResolvedValue({ id: 'sched_x' });
    stripe.subscriptionSchedules.retrieve.mockResolvedValue({ id: 'sched_x', current_phase: { start_date: 100, end_date: end }, phases: [{ start_date: 100, end_date: end, items: [{ price: 'price_pre_m', quantity: 1 }], discounts: [] }] });

    const r = await scheduleChange({ accountId: 1, planCode: 'standard', billingPeriod: 'monthly', displayedPriceRevision: REV });

    expect(r.ok).toBe(true);
    expect(updates[0]).toMatchObject({ scheduledStripePriceId: 'price_std_m', scheduledPriceRevision: REV, scheduledUnitAmountCents: 100, scheduledCurrency: 'eur', scheduledScheduleId: 'sched_x', scheduledChangeState: null });
    expect(revaluation.supersede).toHaveBeenCalledWith('sub_1', 'SUPERSEDED_BY_USER_CHANGE');
    expect(operations.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'schedule', previousPriceId: 'price_pre_m', previousAmountCents: 590 }));
  });

  it('TC-36 — programmation sans révision : refusée, rien n’est inscrit chez Stripe', async () => {
    selectResults = [[{ planCode: 'premium', billingPeriod: 'monthly', currentPeriodEndAt: null, stripeSubscriptionId: 'sub_1' }]];
    const r = await scheduleChange({ accountId: 1, planCode: 'standard', billingPeriod: 'monthly' });
    expect(r).toMatchObject({ ok: false, reason: 'PRICE_CONFIRMATION_REQUIRED' });
    expect(stripe.subscriptionSchedules.update).not.toHaveBeenCalled();
  });

  it('TC-50 — prix appliqué ≠ catalogue courant mais = cible ENREGISTRÉE : changement constaté', async () => {
    selectResults = [[{ scheduledPlanCode: 'standard', scheduledBillingPeriod: 'monthly', scheduledStripePriceId: 'price_std_m_ancien_accepte', stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: 'sched', items: { data: [{ id: 'si_1', price: { id: 'price_std_m_ancien_accepte' } }] } });
    expect(await applyScheduledChange(1)).toEqual({ applied: true, planCode: 'standard', billingPeriod: 'monthly' });
  });

  it('TC-50 — item au prix courant du catalogue mais ≠ cible enregistrée : PAS consommé', async () => {
    selectResults = [[{ scheduledPlanCode: 'standard', scheduledBillingPeriod: 'monthly', scheduledStripePriceId: 'price_std_m_ancien_accepte', stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: 'sched', items: { data: [{ id: 'si_1', price: { id: 'price_std_m' } }] } });
    expect(await applyScheduledChange(1)).toMatchObject({ applied: false });
  });

  it('TC-52 / LK-59 — libération refusée par Stripe : l’intention est CONSERVÉE (état release_failed)', async () => {
    selectResults = [[{ stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: 'sched_1', items: { data: [] } });
    stripe.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe indisponible'));
    const r = await cancelScheduledChange(1);
    expect(r).toEqual({ ok: false, reason: 'RELEASE_FAILED' });
    expect(updates).toEqual([expect.objectContaining({ scheduledChangeState: 'release_failed' })]);
    expect(updates[0]).not.toHaveProperty('scheduledPlanCode');
  });

  it('LK-59 — absence d’échéancier vérifiée : annulation locale autorisée', async () => {
    selectResults = [[{ stripeSubscriptionId: 'sub_1' }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: null, items: { data: [] } });
    expect(await cancelScheduledChange(1)).toEqual({ ok: true, released: 'absent' });
    expect(updates[0]).toMatchObject({ scheduledPlanCode: null, scheduledStripePriceId: null, scheduledChangeState: null });
  });

  it('LK-56 — échéancier étranger avec phases futures non reconnues : refus, rien n’est écrasé', async () => {
    selectResults = [[{ planCode: 'premium', billingPeriod: 'yearly', currentPeriodEndAt: null, stripeSubscriptionId: 'sub_1', scheduledPlanCode: null }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', schedule: 'sched_ext', items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_pre_y' } }] } });
    stripe.subscriptionSchedules.retrieve.mockResolvedValue({ id: 'sched_ext', metadata: {}, current_phase: { start_date: 100, end_date: end }, phases: [
      { start_date: 100, end_date: end, items: [{ price: 'price_pre_y', quantity: 1 }] },
      { start_date: end, end_date: end + 100, items: [{ price: 'price_autre', quantity: 1 }] },
    ] });
    const r = await scheduleChange({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', displayedPriceRevision: REV });
    expect(r).toEqual({ ok: false, reason: 'FOREIGN_SCHEDULE' });
    expect(stripe.subscriptionSchedules.update).not.toHaveBeenCalled();
  });

  it('TC-53 — remises reportées PAR IDENTIFIANT, taux de taxe et quantité conservés', () => {
    const phases = buildChangePhases({
      start_date: 100, end_date: 200,
      items: [{ price: 'price_pre_m', quantity: 1, tax_rates: [{ id: 'txr_1' }] }],
      discounts: [{ discount: 'di_promo', coupon: 'co_x', promotion_code: null }],
      default_tax_rates: ['txr_def'],
      metadata: {},
    } as never, 'price_std_m', 'monthly', 1);
    expect(phases[0]).toMatchObject({ items: [{ price: 'price_pre_m', quantity: 1, tax_rates: ['txr_1'] }], discounts: [{ discount: 'di_promo' }], default_tax_rates: ['txr_def'] });
    expect(phases[1]).toMatchObject({ items: [{ price: 'price_std_m', quantity: 1 }], proration_behavior: 'none', default_tax_rates: ['txr_def'] });
  });
});

function PLAN_OF_EXTRA(id: string, plan: string, period: string) {
  PLAN_OF[id] = [plan, period];
}
