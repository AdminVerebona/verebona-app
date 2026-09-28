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

const PRICES: Record<string, string> = {
  STRIPE_PRICE_STANDARD_MONTHLY: 'price_std_m', STRIPE_PRICE_STANDARD_YEARLY: 'price_std_y',
  STRIPE_PRICE_PREMIUM_MONTHLY: 'price_pre_m', STRIPE_PRICE_PREMIUM_YEARLY: 'price_pre_y',
  STRIPE_PRICE_PREMIUM_DUO_MONTHLY: 'price_duo_m', STRIPE_PRICE_PREMIUM_DUO_YEARLY: 'price_duo_y',
};
Object.assign(process.env, PRICES);

const { isUpgrade } = await import('@/lib/stripe-prices');
const { startImmediateUpgrade } = await import('../plan-upgrade.service');
const { scheduleChange, applyScheduledChange } = await import('@/services/plan-change.service');

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

    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', appBaseUrl: 'https://app.test' });

    expect(r).toEqual({ ok: true, url: 'https://billing.stripe.com/p/session/x' });
    const params = stripe.billingPortal.sessions.create.mock.calls[0][0];
    expect(params.configuration).toBe('bpc_upgrade');
    expect(params.flow_data.type).toBe('subscription_update_confirm');
    expect(params.flow_data.subscription_update_confirm.items).toEqual([{ id: 'si_1', price: 'price_pre_m', quantity: 1 }]);
    expect(params.flow_data.after_completion.redirect.return_url).toBe('https://app.test/mon-compte/offres?changement=confirme');
    // Aucune modification directe de l'abonnement : Stripe la fait après paiement.
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('crée une configuration de portail qui encaisse le prorata immédiatement', async () => {
    selectResults = [[{ planCode: 'standard', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', status: 'active', schedule: null, items: { data: [{ id: 'si_1', price: { id: 'price_std_m' } }] } });
    stripe.billingPortal.configurations.list.mockReturnValue((async function* () { /* aucune */ })());
    stripe.prices.retrieve.mockImplementation(async (id: string) => ({ id, product: `prod_${id.split('_')[1]}` }));
    stripe.billingPortal.configurations.create.mockResolvedValue({ id: 'bpc_new' });
    stripe.billingPortal.sessions.create.mockResolvedValue({ url: 'u' });

    await startImmediateUpgrade({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly', appBaseUrl: 'https://app.test' });

    const conf = stripe.billingPortal.configurations.create.mock.calls[0][0];
    expect(conf.features.subscription_update.proration_behavior).toBe('always_invoice');
    expect(conf.features.subscription_update.enabled).toBe(true);
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

    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'premium_duo', billingPeriod: 'monthly', appBaseUrl: 'x' });

    expect(r.ok).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({ scheduledPlanCode: null, scheduledBillingPeriod: null, scheduledChangeAt: null }));
  });

  it('refuse une baisse de gamme', async () => {
    selectResults = [[{ planCode: 'premium_duo', status: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', ownerUserId: 5 }]];
    const r = await startImmediateUpgrade({ accountId: 1, planCode: 'standard', billingPeriod: 'monthly', appBaseUrl: 'x' });
    expect(r).toEqual({ ok: false, reason: 'NOT_AN_UPGRADE' });
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});

describe('baisse de gamme programmée', () => {
  const periodEnd = new Date('2026-11-14T00:00:00Z');

  it('refuse de programmer une montée en gamme', async () => {
    selectResults = [[{ planCode: 'standard', billingPeriod: 'monthly', currentPeriodEndAt: periodEnd, stripeSubscriptionId: 'sub_1' }]];
    expect(await scheduleChange({ accountId: 1, planCode: 'premium', billingPeriod: 'monthly' }))
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

    const r = await scheduleChange({ accountId: 1, planCode: 'standard', billingPeriod: 'monthly' });

    expect(r).toEqual({ ok: true, effectiveAt: periodEnd });
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
    const r = await scheduleChange({ accountId: 1, planCode: 'premium', billingPeriod: 'yearly' });
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

    const r = await scheduleChange({ accountId: 1, planCode: 'premium', billingPeriod: 'yearly' });

    // Date de bascule : celle de Stripe (fin de phase), enregistrée telle quelle.
    expect(r).toEqual({ ok: true, effectiveAt: periodEnd });
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
    await scheduleChange({ accountId: 1, planCode: 'standard', billingPeriod: 'monthly' });
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
