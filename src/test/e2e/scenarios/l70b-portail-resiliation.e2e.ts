/**
 * Lot 70B — portail Stripe en résiliation « fin de période » imposée par
 * Verebona (décision PO 19/10 n° 2, CDC Centre d'aide AID-BILL-007), sur
 * PostgreSQL 16 réel ; Stripe SIMULÉ (configurations du portail, sessions,
 * abonnements, aperçu de facture). Le portail par défaut simulé est réglé
 * sur l'annulation IMMÉDIATE : Verebona ne doit jamais l'utiliser.
 *
 * L70-PORT-E01 « Mon compte » / lien permanent : la route crée (une fois) la
 *              configuration Verebona puis ouvre chaque session avec elle.
 * L70-PORT-E02 Rappel J−7 : la configuration Verebona est vérifiée (plus le
 *              portail par défaut) — les rappels partent alors que le
 *              portail par défaut annule immédiatement.
 * L70-PORT-E03 Garde-fou : configuration ni trouvée ni créée → aucun rappel,
 *              tâche en échec, anomalie BO, portail refusé (503) ; réparé →
 *              rappels repris au passage suivant (même jour), anomalie résolue.
 * L70-PORT-E04 Résiliation depuis le portail (cancel_at_period_end) remontée
 *              par webhook : « Résiliation programmée », offre conservée
 *              jusqu'à l'échéance, plus de rappel.
 */
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakePortalConfigurations } from '../../fakes/stripe-portal-configurations';

const APP = 'https://app.e2e.verebona.test';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_70b';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  return {
    subs: new Map<string, Record<string, unknown> & { id: string }>(),
    sessions: [] as Array<Record<string, unknown>>,
  };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({ data: { id: 'em_70b' }, error: null }) }; } }));

const portal = createFakePortalConfigurations({
  defaultConfiguration: {
    features: {
      invoice_history: { enabled: true }, payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'immediately', proration_behavior: 'create_prorations' },
    },
  },
});
const fakeStripe = {
  subscriptions: { retrieve: async (id: string) => structuredClone(etat.subs.get(id)) },
  invoices: {
    createPreview: async (p: { subscription?: string }) => {
      const s = etat.subs.get(p.subscription ?? '') as { items: { data: Array<{ current_period_end: number }> } } | undefined;
      const start = s!.items.data[0].current_period_end;
      return { amount_due: 5900, currency: 'eur', lines: { data: [{ period: { start, end: start + 365 * 86400 } }] } };
    },
  },
  billingPortal: {
    configurations: portal.configurations,
    sessions: { create: async (p: Record<string, unknown>) => { etat.sessions.push(p); return { url: `https://billing.stripe.com/p/session/test_70b_${etat.sessions.length}` }; } },
  },
};
vi.mock('@/lib/stripe', async (orig) => ({ ...(await orig<object>()), getStripeServer: () => fakeStripe }));

const YEARLY = 'price_e2e_l70b_premium_yearly';
const DAY = 86_400;
const tsOf = (d: Date) => Math.floor(d.getTime() / 1000);
const FINGERPRINT = 'stripe:customer-portal:configuration';

function req(path: string, cookie?: string, method = 'POST') {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`${APP}${path}`, { method, headers, body: method === 'GET' ? undefined : '{}' });
}

scenario('L70-PORT', 'Portail Stripe : résiliation en fin de période imposée par Verebona', ({ sql, make }) => {
  let paris: (day: string, hh?: number, mm?: number) => Date;

  beforeAll(async () => {
    const { parisWallTimeToDate } = await import('@/services/scheduling/task-calendar');
    paris = (day, hh = 9, mm = 0) => parisWallTimeToDate(day, [hh, mm]);
    const { getStripeCatalogContext } = await import('@/lib/stripe-client');
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { versionRowFrom } = await import('@/services/billing/price-history.service');
    await pgCatalogStore.upsertPriceVersion(versionRowFrom(
      { id: YEARLY, livemode: false, product: 'prod_e2e_l70b', lookup_key: null, unit_amount: 5900, currency: 'eur', tax_behavior: 'unspecified', active: true, recurring: { interval: 'year', interval_count: 1 } } as unknown as Stripe.Price,
      'premium', 'yearly', { catalogContext: getStripeCatalogContext().catalogContext }, 'e2e',
    ));
  });

  beforeEach(async () => {
    portal.behaviour.failCreate = null;
    (await import('@/services/billing/annual-renewal-reminder.service')).resetPortalCheckCache();
    (await import('@/services/billing/customer-portal-configuration.service')).resetCustomerPortalConfigurationCache();
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    // Lot 72F : bascule DÉCLARÉE (sinon aucun rappel n'est préparé).
    await sql`INSERT INTO annual_renewal_reminder_state (id, coverage_from, stripe_reminders_disabled_at) VALUES (1, '2030-01-01', '2029-12-31T10:00:00Z')
              ON CONFLICT (id) DO UPDATE SET coverage_from = '2030-01-01', stripe_reminders_disabled_at = '2029-12-31T10:00:00Z'`;
  });
  afterAll(async () => {
    await sql`UPDATE annual_renewal_reminder_state SET stripe_reminders_disabled_at = NULL WHERE id = 1`;
  });

  async function titulaire(end: Date) {
    const email = `titulaire-${uid('l70b')}@test.invalid`;
    const owner = await make.user({ email, planType: 'PREMIUM' });
    const acc = await make.account({ owner, plan: 'premium' });
    const customer = `cus_${uid('l70b')}`;
    const subId = `sub_${uid('l70b')}`;
    await sql`UPDATE accounts SET plan_type = 'PREMIUM', subscription_status = 'ACTIVE', stripe_customer_id = ${customer}, stripe_subscription_id = ${subId} WHERE id = ${acc.id}`;
    await sql`UPDATE account_subscriptions SET stripe_customer_id = ${customer}, stripe_subscription_id = ${subId}, billing_period = 'yearly',
                     current_period_end_at = ${end.toISOString()}, cancel_at_period_end = false, status = 'active' WHERE account_id = ${acc.id}`;
    const e = tsOf(end);
    etat.subs.set(subId, {
      id: subId, object: 'subscription', customer, status: 'active', cancel_at_period_end: false, cancel_at: null, trial_end: null, schedule: null,
      metadata: {}, start_date: e - 365 * DAY, created: e - 365 * DAY,
      items: { data: [{ id: `si_${subId}`, quantity: 1, current_period_start: e - 365 * DAY, current_period_end: e,
        price: { id: YEARLY, object: 'price', product: 'prod_e2e_l70b', unit_amount: 5900, currency: 'eur', tax_behavior: 'unspecified', active: true, lookup_key: null, livemode: false, recurring: { interval: 'year', interval_count: 1 } } }] },
    });
    return { ...acc, email, customer, subId };
  }
  const jeton = async (id: number, email: string) => {
    const { generateAccessToken } = await import('@/lib/jwt');
    return `access_token=${await generateAccessToken({ id, email, role: 'USER' as never, planType: 'PREMIUM' as never, status: 'ACTIVE' as never, hasActiveAccount: true })}`;
  };
  const openPortal = async (t: { ownerUserId: number; email: string }) => {
    const { POST } = await import('@/app/api/billing/create-customer-portal-session/route');
    return POST(req('/api/billing/create-customer-portal-session', await jeton(t.ownerUserId, t.email)));
  };
  const run = async (now: Date) => (await import('@/services/billing/annual-renewal-reminder.service'))
    .runAnnualRenewalReminders({ now, stripe: fakeStripe as never, deadline: Date.now() + 60_000 });
  const jobsOf = (subId: string) => sql<{ status: string }[]>`
    SELECT status FROM transactional_email_jobs WHERE kind = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' AND context ->> 'subscriptionId' = ${subId}`;
  const anomaly = async () => (await sql<{ status: string; occurrence_count: number }[]>`
    SELECT status, occurrence_count FROM admin_anomalies WHERE fingerprint = ${FINGERPRINT} ORDER BY id DESC LIMIT 1`)[0] ?? null;

  it('L70-PORT-E01 — Mon compte / lien permanent : configuration Verebona créée une fois, utilisée par chaque session', async () => {
    const a = await titulaire(paris('2033-06-20', 10));
    const b = await titulaire(paris('2033-06-21', 10));
    const n = etat.sessions.length;

    const r1 = await openPortal(a);
    expect(r1.status).toBe(200);
    const [mine] = portal.verebonaConfigurations();
    expect(mine).toBeDefined();
    expect(mine.features.subscription_cancel).toMatchObject({ enabled: true, mode: 'at_period_end', proration_behavior: 'none' });
    expect(mine.features).toMatchObject({ invoice_history: { enabled: true }, payment_method_update: { enabled: true } });

    const r2 = await openPortal(b);
    expect(r2.status).toBe(200);
    expect(portal.verebonaConfigurations()).toHaveLength(1); // jamais recréée
    expect(etat.sessions.slice(n)).toEqual([
      { customer: a.customer, return_url: `${APP}/mon-compte`, locale: 'fr', configuration: mine.id },
      { customer: b.customer, return_url: `${APP}/mon-compte`, locale: 'fr', configuration: mine.id },
    ]);
    // Le portail par défaut (annulation immédiate) n'est ni utilisé ni modifié.
    expect(portal.defaultConfiguration()!.features.subscription_cancel).toMatchObject({ mode: 'immediately' });
    expect(portal.calls.update.filter((u) => u.id === portal.defaultConfiguration()!.id)).toEqual([]);
  });

  it('L70-PORT-E02 — rappel J−7 : configuration Verebona vérifiée, rappels préparés malgré un portail par défaut « immédiat »', async () => {
    const t = await titulaire(paris('2033-07-10', 10));
    const r = await run(paris('2033-07-03', 8, 30));
    expect(r.skipped).toBeUndefined();
    expect(r.portalAllowsDisable).toBe(true);
    expect(r.portalConfigurationId).toBe(portal.verebonaConfigurations()[0].id);
    expect(r.enqueued).toBe(1);
    expect((await jobsOf(t.subId)).map((j) => j.status)).toEqual(['pending']);
  });

  it('L70-PORT-E03 — garde-fou : configuration ni trouvée ni créée → rappels bloqués, anomalie BO, portail refusé ; réparé → repris', async () => {
    // Configuration Verebona supprimée côté Stripe, création refusée.
    for (const c of portal.verebonaConfigurations()) portal.store.delete(c.id);
    portal.behaviour.failCreate = Object.assign(new Error('Invalid portal configuration'), { type: 'StripeInvalidRequestError', statusCode: 400 });
    const t = await titulaire(paris('2033-08-10', 10));

    const r = await run(paris('2033-08-03', 8, 30));
    expect(r).toMatchObject({ skipped: 'PORTAL_CANCEL_DISABLED', portalAllowsDisable: false, enqueued: 0 });
    expect(await jobsOf(t.subId)).toHaveLength(0);
    expect(await anomaly()).toMatchObject({ status: 'open' });

    // Tâche planifiée : en échec avec un message explicite (alerte BO du planificateur).
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const service = await import('@/services/billing/annual-renewal-reminder.service');
    const spy = vi.spyOn(service, 'runAnnualRenewalReminders').mockResolvedValueOnce(r);
    const out = await findTask('subscription-annual-renewal-reminders')!.run({ deadline: Date.now() + 60_000 } as never);
    expect(out).toMatchObject({ error: expect.stringContaining('configuration Verebona du portail Stripe') });
    spy.mockRestore();

    // Portail : le défaut annule immédiatement → refus, aucune session.
    const n = etat.sessions.length;
    const refus = await openPortal(t);
    expect(refus.status).toBe(503);
    expect((await refus.json()).code).toBe('PORTAL_SESSION_FAILED');
    expect(etat.sessions.length).toBe(n);

    // Réparé (création de nouveau possible) : le passage suivant du MÊME jour reprend (échec non mémorisé).
    portal.behaviour.failCreate = null;
    const r2 = await run(paris('2033-08-03', 9, 30));
    expect(r2).toMatchObject({ portalAllowsDisable: true, enqueued: 1 });
    expect(r2.skipped).toBeUndefined();
    expect(await anomaly()).toMatchObject({ status: 'resolved' });
    expect((await openPortal(t)).status).toBe(200);
  });

  it('L70-PORT-E04 — résiliation depuis le portail : cancel_at_period_end remonté par webhook, « Résiliation programmée », plus de rappel', async () => {
    const t = await titulaire(paris('2033-09-20', 10));
    expect((await openPortal(t)).status).toBe(200);
    // Le client annule dans le portail Verebona (fin de période) : Stripe pose cancel_at_period_end.
    const sub = etat.subs.get(t.subId) as unknown as Record<string, unknown> & { items: { data: Array<{ current_period_end: number }> } };
    sub.cancel_at_period_end = true;
    sub.cancel_at = sub.items.data[0].current_period_end;
    const { syncSubscriptionFromEvent } = await import('@/services/billing/subscription-sync.service');
    await syncSubscriptionFromEvent({ id: t.subId }, { source: 'webhook:customer.subscription.updated', notify: false }, async (id) => structuredClone(etat.subs.get(id)) as never);

    const [row] = await sql<{ cancel_at_period_end: boolean; status: string }[]>`SELECT cancel_at_period_end, status FROM account_subscriptions WHERE account_id = ${t.id}`;
    expect(row).toEqual({ cancel_at_period_end: true, status: 'active' }); // abonnement actif jusqu'à l'échéance
    const [acc] = await sql<{ subscription_status: string; plan_type: string }[]>`SELECT subscription_status, plan_type FROM accounts WHERE id = ${t.id}`;
    expect(acc).toEqual({ subscription_status: 'CANCELED', plan_type: 'PREMIUM' }); // résiliation programmée, offre conservée

    // « Mon compte » (SubscriptionSummary) lit cancelAtPeriodEnd → « Résiliation programmée ».
    const { GET } = await import('@/app/api/billing/trial-status/route');
    const res = await GET(req('/api/billing/trial-status', await jeton(t.ownerUserId, t.email), 'GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).subscription).toMatchObject({ cancelAtPeriodEnd: true, billingPeriod: 'yearly' });

    await run(paris('2033-09-13', 8, 30));
    expect(await jobsOf(t.subId)).toHaveLength(0);
  });
});
