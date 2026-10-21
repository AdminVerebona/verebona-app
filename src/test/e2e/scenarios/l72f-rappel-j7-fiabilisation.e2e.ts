/**
 * Lot 72F — ticket P1 « Abonnements annuels — Fiabiliser le rappel J−7 avant
 * renouvellement », sur PostgreSQL 16 réel (toutes les migrations, dont 0524),
 * Stripe SIMULÉ et Resend SIMULÉ — le double de Resend applique les règles
 * d'idempotence du prestataire (même clé + même contenu → réponse d'origine,
 * sans second e-mail ; même clé + autre contenu → 409 ; fenêtre de 24 h non
 * simulée : la réconciliation au-delà passe par la consultation de l'e-mail).
 *
 * Scénarios en 2034 (jamais vus par les autres fichiers : 2031-2033).
 *
 * RJ7F-E2E-01 Réponse Resend perdue après acceptation : reprise avec la MÊME
 *             clé → un seul e-mail, demande acceptée avec l'identifiant Resend.
 * RJ7F-E2E-02 Arrêt du processus après acceptation (verrou expiré) : aucune
 *             réémission aveugle ; au-delà de la fenêtre d'idempotence :
 *             consultation Resend (étiquette de la demande) → accepté ; clé
 *             limitée à l'envoi → « acceptation incertaine » bloquée, anomalie
 *             BO, aucune réémission ; décision BO « réémettre » → nouvel envoi.
 * RJ7F-E2E-03 Refus confirmé (422) : nouvelle génération de clé, reprise ;
 *             panne 5xx / réseau : incertain, même clé ; webhook étiqueté →
 *             réconciliation sans identifiant.
 * RJ7F-E2E-04 Suspension avec demandes en attente : aucun rappel annuel envoyé
 *             (file et envoi), les autres e-mails partent ; bascule non
 *             déclarée : aucun envoi.
 * RJ7F-E2E-05 Portail : plusieurs comptes payants → portail du compte du lien ;
 *             invité Duo et compte d'autrui refusés (réponse uniforme) ;
 *             incohérence compte / client Stripe refusée ; aucune session
 *             Stripe sans autorisation ; lien sans référence inchangé.
 * RJ7F-E2E-06 Lien de l'e-mail : référence durable du compte facturé ;
 *             déconnecté → connexion puis retour sur le MÊME lien.
 * RJ7F-E2E-07 Libellé d'offre aligné sur le prix Stripe de la prochaine
 *             échéance (changement programmé), jamais sur plan_code local ;
 *             offre non identifiable → jamais envoyé (échec temporaire).
 * RJ7F-E2E-08 Erreur Stripe à la vérification : journal persistant (étape,
 *             motif, prochaine tentative), reprise au passage suivant.
 * RJ7F-E2E-09 Bascule : non déclarée → rien ; J−7 au plus tard le jour de la
 *             désactivation Stripe → « couverture incertaine » signalée, pas
 *             d'envoi automatique ; décisions BO ; retour arrière : demandes en
 *             attente neutralisées, plus aucun envoi.
 * RJ7F-E2E-10 Réconciliation planifiée : données locales désynchronisées →
 *             resynchronisées (subscription-sync) puis rappel ; abonnement
 *             Stripe absent localement → anomalie ; résiliation Stripe → état
 *             local synchronisé.
 * RJ7F-E2E-11 Double exécution simultanée (traitement + envois) : aucun doublon.
 * RJ7F-E2E-12 BO : états distincts (préparé, accepté, livré, échec temporaire,
 *             incertain, annulé, exclu), planificateur et couverture.
 */
import type Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakePortalConfigurations } from '../../fakes/stripe-portal-configurations';

const APP = 'https://app.e2e.verebona.test';

const mail = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_72f';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  type Sent = { id: string; to: string; subject: string; html: string; text: string; tags?: Array<{ name: string; value: string }>; key?: string; created_at: string };
  return {
    sent: [] as Sent[],
    byKey: new Map<string, { id: string; body: string }>(),
    /** Comportement du prochain appel d'envoi. */
    next: [] as Array<'lose-response' | 'error-500-before' | 'reject-422' | 'down'>,
    listForbidden: false,
    getCalls: 0,
    listCalls: 0,
    /** Horloge du prestataire (created_at) : alignée sur l'instant du test. */
    clock: new Date(),
    /** Lot 76D : appel d'envoi suspendu (appel Resend « en cours ») jusqu'à la levée de la barrière. */
    gate: null as Promise<void> | null,
    onSendStart: null as (() => void) | null,
    /** Lot 76D : consultations d'e-mails en échec (identifiants), délai de consultation. */
    getFail: new Set<string>(),
  };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string; text: string; tags?: Array<{ name: string; value: string }> }, o?: { idempotencyKey?: string }) => {
        const gate = mail.gate;
        if (gate) { mail.gate = null; mail.onSendStart?.(); await gate; }
        const mode = mail.next.shift();
        const key = o?.idempotencyKey;
        const body = JSON.stringify(p);
        if (mode === 'down') return { data: null, error: { name: 'application_error', statusCode: null, message: 'Unable to fetch data. The request could not be resolved.' } };
        if (mode === 'error-500-before') return { data: null, error: { name: 'internal_server_error', statusCode: 500, message: 'Internal server error' } };
        if (mode === 'reject-422') return { data: null, error: { name: 'validation_error', statusCode: 422, message: 'Invalid `to` field.' } };
        if (key && mail.byKey.has(key)) {
          const prev = mail.byKey.get(key)!;
          if (prev.body !== body) return { data: null, error: { name: 'invalid_idempotent_request', statusCode: 409, message: 'Same idempotency key used with a different request payload.' } };
          return { data: { id: prev.id }, error: null };
        }
        const id = `em_72f_${mail.sent.length + 1}`;
        mail.sent.push({ id, ...p, key, created_at: mail.clock.toISOString() });
        if (key) mail.byKey.set(key, { id, body });
        if (mode === 'lose-response') return { data: null, error: { name: 'application_error', statusCode: null, message: 'Unable to fetch data. The request could not be resolved.' } };
        return { data: { id }, error: null };
      },
      get: async (id: string) => {
        mail.getCalls += 1;
        if (mail.listForbidden) return { data: null, error: { name: 'restricted_api_key', statusCode: 401, message: 'This API key is restricted to only send emails' } };
        if (mail.getFail.has(id)) return { data: null, error: { name: 'internal_server_error', statusCode: 500, message: 'Internal server error' } };
        const m = mail.sent.find((x) => x.id === id);
        if (!m) return { data: null, error: { name: 'not_found', statusCode: 404, message: 'Email not found' } };
        return { data: { object: 'email', id: m.id, to: [m.to], subject: m.subject, created_at: m.created_at, last_event: 'sent', tags: m.tags ?? [] }, error: null };
      },
      list: async (o: { limit?: number; after?: string } = {}) => {
        mail.listCalls += 1;
        if (mail.listForbidden) return { data: null, error: { name: 'restricted_api_key', statusCode: 401, message: 'This API key is restricted to only send emails' } };
        const all = [...mail.sent].reverse();
        const start = o.after ? all.findIndex((x) => x.id === o.after) + 1 : 0;
        const page = all.slice(start, start + (o.limit ?? 20));
        return { data: { object: 'list', has_more: start + page.length < all.length, data: page.map((m) => ({ id: m.id, to: [m.to], subject: m.subject, created_at: m.created_at, last_event: 'sent' })) }, error: null };
      },
    };
  },
}));

const etat = vi.hoisted(() => ({
  subs: new Map<string, Record<string, unknown> & { id: string }>(),
  amounts: new Map<string, number | null>(),
  /** Prix de la ligne de renouvellement de l'aperçu (changement programmé). */
  previewPrice: new Map<string, string>(),
  sessions: [] as Array<{ customer: string }>,
  stripeDown: false,
  /** Lot 76D : relecture d'un abonnement précis en échec. */
  failRetrieve: new Map<string, Error>(),
}));

const portalFake = createFakePortalConfigurations({ defaultConfiguration: { features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end' } } } });
const fakeStripe = {
  subscriptions: {
    retrieve: async (id: string) => {
      if (etat.stripeDown) throw Object.assign(new Error('Stripe indisponible (simulé)'), { type: 'StripeConnectionError' });
      if (etat.failRetrieve.has(id)) throw etat.failRetrieve.get(id);
      const s = etat.subs.get(id);
      if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing', statusCode: 404 });
      return structuredClone(s);
    },
    list: async (p: { status?: string; limit?: number; starting_after?: string }) => {
      if (etat.stripeDown) throw Object.assign(new Error('Stripe indisponible (simulé)'), { type: 'StripeConnectionError' });
      const all = [...etat.subs.values()].filter((s) => !p.status || p.status === 'all' || s.status === p.status).sort((a, b) => a.id.localeCompare(b.id));
      const start = p.starting_after ? all.findIndex((s) => s.id === p.starting_after) + 1 : 0;
      const page = all.slice(start, start + (p.limit ?? 10));
      return { object: 'list', data: structuredClone(page), has_more: start + page.length < all.length };
    },
  },
  invoices: {
    createPreview: async (p: { subscription?: string; schedule?: string }) => {
      if (etat.stripeDown) throw new Error('Stripe indisponible (simulé)');
      const id = p.subscription ?? '';
      const s = etat.subs.get(id) as { items: { data: Array<{ current_period_end: number; price: { id: string } }> } } | undefined;
      const amount = etat.amounts.has(id) ? etat.amounts.get(id) : 5900;
      if (!s || amount == null) return { amount_due: null, currency: 'eur', lines: { data: [] } };
      const start = s.items.data[0].current_period_end;
      const price = etat.previewPrice.get(id) ?? s.items.data[0].price.id;
      return { amount_due: amount, currency: 'eur', lines: { data: [{ period: { start, end: start + 365 * 86400 }, pricing: { type: 'price_details', price_details: { price, product: 'prod_e2e_l72f' } } }] } };
    },
  },
  prices: {
    retrieve: async (id: string) => { throw Object.assign(new Error(`No such price: ${id}`), { code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError' }); },
  },
  billingPortal: {
    configurations: portalFake.configurations,
    sessions: {
      create: async (p: { customer: string }) => {
        etat.sessions.push(p);
        return { url: `https://billing.stripe.com/p/session/test_72f_${etat.sessions.length}` };
      },
    },
  },
};
vi.mock('@/lib/stripe', async (orig) => ({ ...(await orig<object>()), getStripeServer: () => fakeStripe }));

const YEARLY = 'price_e2e_l72f_premium_yearly';
const DUO_YEARLY = 'price_e2e_l72f_duo_yearly';
const MONTHLY = 'price_e2e_l72f_premium_monthly';
const DAY = 86_400;
const tsOf = (d: Date) => Math.floor(d.getTime() / 1000);
const TASK = 'subscription-annual-renewal-reminders';

function req(path: string, init: { cookie?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  const method = init.method ?? 'POST';
  return new NextRequest(`${APP}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(init.body ?? {}) });
}

scenario('RJ7F', 'Abonnements annuels : fiabilisation du rappel J−7 (lot 72F)', ({ sql, make }) => {
  let paris: (day: string, hh?: number, mm?: number) => Date;
  let adminId: number;

  beforeAll(async () => {
    const { parisWallTimeToDate } = await import('@/services/scheduling/task-calendar');
    paris = (day, hh = 9, mm = 0) => parisWallTimeToDate(day, [hh, mm]);
    const { getStripeCatalogContext } = await import('@/lib/stripe-client');
    const ctx = getStripeCatalogContext().catalogContext;
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { versionRowFrom } = await import('@/services/billing/price-history.service');
    for (const [id, plan, interval, period, amount] of [
      [YEARLY, 'premium', 'year', 'yearly', 5900], [DUO_YEARLY, 'premium_duo', 'year', 'yearly', 8900], [MONTHLY, 'premium', 'month', 'monthly', 590],
    ] as const) {
      await pgCatalogStore.upsertPriceVersion(versionRowFrom(
        { id, livemode: false, product: 'prod_e2e_l72f', lookup_key: null, unit_amount: amount, currency: 'eur', tax_behavior: 'unspecified', active: true, recurring: { interval, interval_count: 1 } } as unknown as Stripe.Price,
        plan, period, { catalogContext: ctx }, 'e2e',
      ));
    }
    adminId = (await make.user({ role: 'ADMIN' })).id;
  });

  /** Bascule déclarée (rappels Stripe désactivés en 2033) et tâches actives. */
  async function basculeActive() {
    await sql`INSERT INTO annual_renewal_reminder_state (id, coverage_from, stripe_reminders_disabled_at) VALUES (1, '2033-12-31', '2033-12-30T10:00:00Z')
              ON CONFLICT (id) DO UPDATE SET coverage_from = '2033-12-31', stripe_reminders_disabled_at = '2033-12-30T10:00:00Z',
                                             rollback_status = NULL, rollback_completed_at = NULL, rollback_summary = NULL`;
    await sql`UPDATE scheduled_task_state SET admin_disabled = false WHERE code IN (${TASK}, 'subscription-annual-renewal-reconcile')`;
  }

  beforeEach(async () => {
    etat.stripeDown = false;
    mail.next.length = 0;
    mail.listForbidden = false;
    process.env.RESEND_API_KEY = 're_e2e_simule_72f';
    (await import('@/services/billing/annual-renewal-reminder.service')).resetPortalCheckCache();
    (await import('@/services/billing/customer-portal-configuration.service')).resetCustomerPortalConfigurationCache();
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    await sql`DELETE FROM communication_channel_settings WHERE event_code = 'email:SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER'`;
    await basculeActive();
  });

  afterAll(async () => {
    // Laisse la base comme la migration : tâches suspendues, bascule non déclarée.
    await sql`UPDATE scheduled_task_state SET admin_disabled = true WHERE code IN (${TASK}, 'subscription-annual-renewal-reconcile')`;
    await sql`UPDATE annual_renewal_reminder_state SET stripe_reminders_disabled_at = NULL, rollback_status = NULL WHERE id = 1`;
  });

  function stripeSub(o: { id: string; customer: string; end: Date; price?: string; interval?: 'year' | 'month'; status?: string; cancel?: boolean }) {
    const end = tsOf(o.end);
    const interval = o.interval ?? 'year';
    const price = o.price ?? (interval === 'year' ? YEARLY : MONTHLY);
    return {
      id: o.id, object: 'subscription', customer: o.customer, status: o.status ?? 'active', cancel_at_period_end: o.cancel ?? false, cancel_at: null,
      trial_end: null, schedule: null, metadata: {}, start_date: end - 365 * DAY, created: end - 365 * DAY,
      items: { data: [{
        id: `si_${o.id}`, quantity: 1, current_period_start: end - (interval === 'year' ? 365 : 30) * DAY, current_period_end: end,
        price: { id: price, object: 'price', product: 'prod_e2e_l72f', unit_amount: interval === 'year' ? 5900 : 590, currency: 'eur', tax_behavior: 'unspecified', active: true, lookup_key: null, livemode: false, recurring: { interval, interval_count: 1 } },
      }] },
    };
  }

  async function titulaire(o: { end: Date; plan?: 'premium' | 'premium_duo'; owner?: { id: number; email: string }; price?: string; localPeriod?: 'yearly' | 'monthly'; localCancel?: boolean }) {
    const email = o.owner?.email ?? `rj7f-${uid('l72')}@test.invalid`;
    const owner = o.owner ?? await make.user({ email, planType: 'PREMIUM' });
    await sql`UPDATE users SET first_name = 'Claire', last_name = 'Titulaire' WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: o.plan ?? 'premium' });
    const customer = `cus_${uid('l72')}`;
    const subId = `sub_${uid('l72')}`;
    await sql`UPDATE accounts SET plan_type = ${o.plan === 'premium_duo' ? 'PREMIUM_DUO' : 'PREMIUM'}, subscription_status = 'ACTIVE',
                     stripe_customer_id = ${customer}, stripe_subscription_id = ${subId} WHERE id = ${acc.id}`;
    await sql`UPDATE account_subscriptions SET stripe_customer_id = ${customer}, stripe_subscription_id = ${subId}, billing_period = ${o.localPeriod ?? 'yearly'},
                     current_period_end_at = ${o.end.toISOString()}, cancel_at_period_end = ${o.localCancel ?? false}, status = 'active'
               WHERE account_id = ${acc.id}`;
    etat.subs.set(subId, stripeSub({ id: subId, customer, end: o.end, price: o.price ?? (o.plan === 'premium_duo' ? DUO_YEARLY : YEARLY) }));
    return { ...acc, email, customer, subId };
  }

  const svc = () => import('@/services/billing/annual-renewal-reminder.service');
  const jobs = () => import('@/services/email/transactional-email-jobs.service');
  const run = async (now: Date) => (await svc()).runAnnualRenewalReminders({ now, stripe: fakeStripe as never, deadline: Date.now() + 60_000 });
  const jobsOf = (subId: string) => sql<{ id: number; status: string; last_error: string | null; attempts: number; send_generation: number; provider_outcome: string | null; provider_message_id: string | null }[]>`
    SELECT id, status, last_error, attempts, send_generation, provider_outcome, provider_message_id FROM transactional_email_jobs
     WHERE kind = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' AND context ->> 'subscriptionId' = ${subId} ORDER BY id`;
  const send = async (jobId: number, now: Date) => { mail.clock = now; return (await jobs()).processEmailJob(jobId, now); };
  const mailsTo = (email: string) => mail.sent.filter((c) => c.to === email);
  const jeton = async (id: number, email: string) => {
    const { generateAccessToken } = await import('@/lib/jwt');
    return generateAccessToken({ id, email, role: 'USER' as never, planType: 'PREMIUM' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
  };
  const adminCookie = async () => {
    const { generateAccessToken } = await import('@/lib/jwt');
    const [a] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${adminId}`;
    return `access_token=${await generateAccessToken({ id: adminId, email: a.email, role: 'ADMIN' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true })}`;
  };

  it('RJ7F-E2E-01 — réponse Resend perdue après acceptation : même clé à la reprise, un seul e-mail', async () => {
    const t = await titulaire({ end: paris('2034-01-20', 10) });
    await run(paris('2034-01-13', 8, 30));
    const [job] = await jobsOf(t.subId);
    mail.next.push('lose-response');
    const first = await send(job.id, paris('2034-01-13', 8, 31));
    expect(first.status).toBe('pending'); // incertain : jamais présenté comme échec confirmé ni comme envoyé
    const [mid] = await jobsOf(t.subId);
    expect(mid).toMatchObject({ provider_outcome: 'uncertain', send_generation: 0 });
    expect(await send(job.id, paris('2034-01-13', 8, 33))).toMatchObject({ status: 'accepted' });
    expect(mailsTo(t.email)).toHaveLength(1);
    const keys = [...mail.byKey.keys()].filter((k) => k.startsWith(`vb-email-job-${job.id}-`));
    expect(keys).toEqual([`vb-email-job-${job.id}-g0`]);
    const [done] = await jobsOf(t.subId);
    expect(done).toMatchObject({ status: 'accepted', provider_message_id: mailsTo(t.email)[0].id });
  });

  it('RJ7F-E2E-02 — arrêt après acceptation : jamais de réémission aveugle ; hors fenêtre : consultation Resend, sinon blocage + BO', async () => {
    // a) Processus arrêté juste après l'acceptation (verrou expiré, aucune réponse traitée).
    const a = await titulaire({ end: paris('2034-02-20', 10) });
    await run(paris('2034-02-13', 8, 30));
    const [ja] = await jobsOf(a.subId);
    mail.next.push('lose-response');
    await send(ja.id, paris('2034-02-13', 8, 31));
    // Simule l'arrêt : demande restée « sending », verrou expiré.
    await sql`UPDATE transactional_email_jobs SET status = 'sending', locked_until = ${paris('2034-02-13', 8, 32).toISOString()} WHERE id = ${ja.id}`;
    // 26 h plus tard (fenêtre d'idempotence dépassée) : consultation de l'e-mail chez Resend (étiquette de la demande).
    const later = paris('2034-02-14', 10, 40);
    expect(await send(ja.id, later)).toMatchObject({ status: 'accepted' });
    expect(mailsTo(a.email)).toHaveLength(1);
    expect(mail.listCalls + mail.getCalls).toBeGreaterThan(0);
    const [jaDone] = await jobsOf(a.subId);
    expect(jaDone).toMatchObject({ provider_outcome: 'reconciled', provider_message_id: mailsTo(a.email)[0].id });

    // b) Même situation, clé Resend limitée à l'envoi (consultation impossible) : blocage, anomalie BO, aucun envoi.
    const b = await titulaire({ end: paris('2034-02-21', 10) });
    await run(paris('2034-02-14', 8, 30));
    const [jb] = await jobsOf(b.subId);
    mail.next.push('lose-response');
    await send(jb.id, paris('2034-02-14', 8, 31));
    mail.listForbidden = true;
    expect(await send(jb.id, paris('2034-02-15', 9, 0))).toMatchObject({ status: 'uncertain' });
    expect(mailsTo(b.email)).toHaveLength(1);
    const { runTransactionalEmailRetry } = await jobs();
    await runTransactionalEmailRetry({ now: () => paris('2034-02-15', 9, 5), limit: 500 });
    expect(mailsTo(b.email)).toHaveLength(1); // jamais repris automatiquement
    const overview = await (await svc()).getAnnualRenewalOverview(paris('2034-02-15', 9, 6));
    expect(overview.anomalies.some((x) => x.jobId === jb.id && x.state === 'UNCERTAIN')).toBe(true);
    // Le rappel annuel quotidien ne le « relance » pas non plus.
    await run(paris('2034-02-16', 8, 30));
    expect((await jobsOf(b.subId))[0].status).toBe('uncertain');

    // Décision BO (après vérification du tableau de bord Resend) : « réémettre » → nouvelle clé, nouvel envoi.
    const { POST } = await import('@/app/api/admin/communications/annual-renewal/route');
    const r = await POST(req('/api/admin/communications/annual-renewal', { cookie: await adminCookie(), body: { action: 'job', jobId: jb.id, decision: 'REISSUE' } }));
    expect(r.status).toBe(200);
    mail.listForbidden = false;
    expect(await send(jb.id, paris('2034-02-16', 9, 0))).toMatchObject({ status: 'accepted' });
    expect(mailsTo(b.email)).toHaveLength(2);
    expect((await jobsOf(b.subId))[0].send_generation).toBe(1);
  });

  it('RJ7F-E2E-03 — refus confirmé : nouvelle clé ; 5xx : incertain, même clé ; webhook étiqueté : réconcilié', async () => {
    const t = await titulaire({ end: paris('2034-03-20', 10) });
    await run(paris('2034-03-13', 8, 30));
    const [job] = await jobsOf(t.subId);
    mail.next.push('reject-422');
    expect(await send(job.id, paris('2034-03-13', 8, 31))).toMatchObject({ status: 'pending' });
    let [j] = await jobsOf(t.subId);
    expect(j).toMatchObject({ provider_outcome: 'rejected', send_generation: 1 });
    mail.next.push('error-500-before');
    await send(job.id, paris('2034-03-13', 8, 33));
    [j] = await jobsOf(t.subId);
    expect(j).toMatchObject({ provider_outcome: 'uncertain', send_generation: 1 });
    expect(await send(job.id, paris('2034-03-13', 8, 40))).toMatchObject({ status: 'accepted' });
    expect(mailsTo(t.email)).toHaveLength(1);
    expect(mailsTo(t.email)[0].key).toBe(`vb-email-job-${job.id}-g1`);

    // Webhook Resend étiqueté (vb_email_job) reçu alors que la réponse a été perdue : réconcilié sans consultation.
    const u = await titulaire({ end: paris('2034-03-21', 10) });
    await run(paris('2034-03-14', 8, 30));
    const [ju] = await jobsOf(u.subId);
    mail.next.push('lose-response');
    await send(ju.id, paris('2034-03-14', 8, 31));
    const sentU = mailsTo(u.email)[0];
    const { recordResendEvent } = await import('@/services/email/email-provider-events.service');
    await recordResendEvent(`evt_${uid('w')}`, { type: 'email.sent', created_at: paris('2034-03-14', 8, 31).toISOString(), data: { email_id: sentU.id, tags: { vb_email_job: String(ju.id) } } } as never);
    await sql`UPDATE transactional_email_jobs SET status = 'sending', locked_until = ${paris('2034-03-14', 8, 32).toISOString()} WHERE id = ${ju.id}`;
    mail.listForbidden = true; // la consultation n'est pas nécessaire
    expect(await send(ju.id, paris('2034-03-15', 12, 0))).toMatchObject({ status: 'accepted' });
    expect(mailsTo(u.email)).toHaveLength(1);
    expect((await jobsOf(u.subId))[0].provider_message_id).toBe(sentU.id);
  });

  it('RJ7F-E2E-04 — suspension : aucun rappel annuel en attente envoyé, les autres e-mails partent ; bascule non déclarée : rien', async () => {
    const t = await titulaire({ end: paris('2034-04-20', 10) });
    await run(paris('2034-04-13', 8, 30));
    const [job] = await jobsOf(t.subId);
    const runner = await import('@/services/scheduling/scheduled-task-runner');
    expect((await runner.setTaskAdminDisabled(TASK, true, adminId)).status).toBe('ok');

    // Un e-mail de vérification préparé en même temps.
    const verifEmail = `verif-${uid('l72')}@test.invalid`;
    const u = await make.user({ email: verifEmail });
    await sql`UPDATE users SET is_active = false, first_name = 'Vera' WHERE id = ${u.id}`;
    const { enqueueVerificationEmail, runTransactionalEmailRetry, processEmailJob } = await jobs();
    const v = await enqueueVerificationEmail({ userId: u.id, email: verifEmail, now: paris('2034-04-13', 8, 31) });
    mail.clock = paris('2034-04-13', 8, 32);
    await runTransactionalEmailRetry({ now: () => paris('2034-04-13', 8, 32), limit: 500 });
    expect(mailsTo(verifEmail)).toHaveLength(1);
    expect(mailsTo(t.email)).toHaveLength(0);
    // Même un envoi ciblé de la demande respecte la suspension (sans consommer de tentative).
    expect(await processEmailJob(job.id, paris('2034-04-13', 8, 33))).toMatchObject({ status: 'pending', error: 'TASK_SUSPENDED' });
    expect((await jobsOf(t.subId))[0]).toMatchObject({ status: 'pending', attempts: 0 });
    const [vj] = await sql<{ status: string }[]>`SELECT status FROM transactional_email_jobs WHERE id = ${v.jobId}`;
    expect(vj.status).toBe('accepted');

    // Réactivée : envoyé.
    await runner.setTaskAdminDisabled(TASK, false, adminId);
    expect(await send(job.id, paris('2034-04-13', 8, 40))).toMatchObject({ status: 'accepted' });

    // Bascule non déclarée : aucun rappel préparé ni envoyé.
    await sql`UPDATE annual_renewal_reminder_state SET stripe_reminders_disabled_at = NULL WHERE id = 1`;
    const w = await titulaire({ end: paris('2034-04-21', 10) });
    const r = await run(paris('2034-04-14', 8, 30));
    expect(r.skipped).toBe('SWITCH_NOT_DECLARED');
    expect(await jobsOf(w.subId)).toHaveLength(0);
  });

  it('RJ7F-E2E-05 — portail : compte du lien, invité Duo et compte d’autrui refusés, cohérence client Stripe, session au clic', async () => {
    const { POST } = await import('@/app/api/billing/create-customer-portal-session/route');
    const owner = await make.user({ email: `multi-${uid('l72')}@test.invalid`, planType: 'PREMIUM' });
    const a = await titulaire({ end: paris('2034-05-20', 10), owner });
    const b = await titulaire({ end: paris('2034-05-25', 10), owner });
    const cookie = `access_token=${await jeton(owner.id, owner.email)}`;
    const n = etat.sessions.length;
    // Lien du compte B (session courante = compte A, plus ancien) : portail de B, jamais de A.
    const rb = await POST(req('/api/billing/create-customer-portal-session', { cookie, body: { accountRef: String(b.id) } }));
    expect(rb.status).toBe(200);
    expect(etat.sessions.slice(n).map((s) => s.customer)).toEqual([b.customer]);
    const ra = await POST(req('/api/billing/create-customer-portal-session', { cookie, body: { accountRef: String(a.id) } }));
    expect(ra.status).toBe(200);
    expect(etat.sessions.at(-1)!.customer).toBe(a.customer);

    // Compte d'autrui / inexistant : même refus, aucune session, aucune donnée.
    const other = await titulaire({ end: paris('2034-05-26', 10) });
    const m = etat.sessions.length;
    const r1 = await POST(req('/api/billing/create-customer-portal-session', { cookie, body: { accountRef: String(other.id) } }));
    const r2 = await POST(req('/api/billing/create-customer-portal-session', { cookie, body: { accountRef: '999999999' } }));
    expect([r1.status, r2.status]).toEqual([403, 403]);
    const [c1, c2] = [await r1.json(), await r2.json()];
    expect(c1).toEqual(c2);
    expect(JSON.stringify(c1)).not.toContain(other.customer);
    expect(etat.sessions.length).toBe(m);

    // Invité Duo avec le lien du titulaire : refus DUO_GUEST, aucune session.
    const duo = await titulaire({ end: paris('2034-05-27', 10), plan: 'premium_duo' });
    const [{ id: duoId }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_customer_id, stripe_subscription_id, activated_at)
      VALUES (${duo.ownerUserId}, 'ACTIVE', ${duo.customer}, ${duo.subId}, now()) RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duoId}, max_members = 2 WHERE id = ${duo.id}`;
    const invite = await make.user({ planType: 'PREMIUM_DUO' });
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.id}, ${invite.id}, 'member', 'active')`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES (${duoId}, ${invite.id}, 'ACTIVE', 1, now())`;
    const rg = await POST(req('/api/billing/create-customer-portal-session', { cookie: `access_token=${await jeton(invite.id, invite.email)}`, body: { accountRef: String(duo.id) } }));
    expect(rg.status).toBe(403);
    expect((await rg.json()).code).toBe('DUO_GUEST');
    expect(etat.sessions.length).toBe(m);

    // Incohérence compte / abonnement / client Stripe : refus explicite, jamais un autre portail.
    await sql`UPDATE account_subscriptions SET stripe_customer_id = 'cus_autre_72f' WHERE account_id = ${b.id}`;
    const rx = await POST(req('/api/billing/create-customer-portal-session', { cookie, body: { accountRef: String(b.id) } }));
    expect(rx.status).toBe(409);
    expect((await rx.json()).code).toBe('BILLING_MISMATCH');
    expect(etat.sessions.length).toBe(m);
    await sql`UPDATE account_subscriptions SET stripe_customer_id = ${b.customer} WHERE account_id = ${b.id}`;

    // Référence illisible : refus (jamais de repli silencieux).
    const rz = await POST(req('/api/billing/create-customer-portal-session', { cookie, body: { accountRef: 'abc' } }));
    expect(rz.status).toBe(400);
    // Sans référence (bouton « Mon compte ») : comportement inchangé.
    expect((await POST(req('/api/billing/create-customer-portal-session', { cookie }))).status).toBe(200);
  });

  it('RJ7F-E2E-06 — lien de l’e-mail : référence du compte facturé ; déconnecté → connexion puis retour sur ce lien', async () => {
    const t = await titulaire({ end: paris('2034-06-20', 10) });
    await run(paris('2034-06-13', 8, 30));
    const [job] = await jobsOf(t.subId);
    await send(job.id, paris('2034-06-13', 8, 31));
    const [m] = mailsTo(t.email);
    expect(m.html).toContain(`href="${APP}/mon-compte/abonnement/gerer/${t.id}"`);
    expect(m.html).not.toContain('billing.stripe.com');
    expect(m.html).not.toContain(t.customer);
    const { middleware } = await import('@/middleware');
    const redir = await middleware(new NextRequest(`${APP}/mon-compte/abonnement/gerer/${t.id}`));
    expect(redir.status).toBe(307);
    const back = new URL(redir.headers.get('location')!).searchParams.get('returnUrl');
    expect(back).toBe(`/mon-compte/abonnement/gerer/${t.id}`);
    const { safeReturnUrl } = await import('@/lib/safe-redirect');
    expect(safeReturnUrl(back)).toBe(`/mon-compte/abonnement/gerer/${t.id}`);
  });

  it('RJ7F-E2E-07 — libellé de l’offre de la prochaine échéance Stripe, jamais plan_code local ; offre inconnue : jamais envoyé', async () => {
    // Local « premium », passage programmé à Premium Duo annuel à l'échéance (ligne de l'aperçu Stripe).
    const t = await titulaire({ end: paris('2034-07-20', 10) });
    etat.previewPrice.set(t.subId, DUO_YEARLY);
    etat.amounts.set(t.subId, 8900);
    await run(paris('2034-07-13', 8, 30));
    const [job] = await jobsOf(t.subId);
    await send(job.id, paris('2034-07-13', 8, 31));
    const [m] = mailsTo(t.email);
    expect(m.html).toContain('Votre abonnement annuel Premium Duo sera renouvelé automatiquement');
    expect(m.html).toContain('Montant prévu pour ce renouvellement : 89,00\u00a0€.');

    // Prix de renouvellement non identifiable : échec temporaire, jamais de libellé inventé.
    const u = await titulaire({ end: paris('2034-07-21', 10) });
    etat.previewPrice.set(u.subId, 'price_inconnu_72f');
    await run(paris('2034-07-14', 8, 30));
    const [ju] = await jobsOf(u.subId);
    expect(await send(ju.id, paris('2034-07-14', 8, 31))).toMatchObject({ status: 'pending', error: 'PLAN_UNAVAILABLE' });
    expect(mailsTo(u.email)).toHaveLength(0);
  });

  it('RJ7F-E2E-08 — erreur Stripe à la vérification : journal persistant, prochaine tentative, reprise', async () => {
    const t = await titulaire({ end: paris('2034-08-20', 10) });
    etat.stripeDown = true;
    const r1 = await run(paris('2034-08-13', 8, 30));
    expect(r1.stripeErrors).toBeGreaterThanOrEqual(1);
    const [k] = await sql<{ outcome: string; step: string; reason: string; next_check_at: Date; account_id: number; renewal_date: string; history: unknown[] }[]>`
      SELECT outcome, step, reason, next_check_at, account_id, renewal_date::text, history FROM annual_renewal_reminder_checks WHERE stripe_subscription_id = ${t.subId}`;
    expect(k).toMatchObject({ outcome: 'STRIPE_ERROR', step: 'STRIPE_CHECK', account_id: t.id, renewal_date: '2034-08-20' });
    expect(k.reason).toMatch(/StripeConnectionError|indisponible/);
    expect(new Date(k.next_check_at).getTime()).toBeGreaterThan(paris('2034-08-13', 8, 30).getTime());
    expect(k.history.length).toBe(1);
    etat.stripeDown = false;
    await run(paris('2034-08-13', 9, 30));
    expect(await jobsOf(t.subId)).toHaveLength(1);
    const [k2] = await sql<{ outcome: string; history: unknown[] }[]>`SELECT outcome, history FROM annual_renewal_reminder_checks WHERE stripe_subscription_id = ${t.subId}`;
    expect(k2.outcome).toBe('ENQUEUED');
    expect(k2.history.length).toBe(2);
  });

  it('RJ7F-E2E-09 — bascule : couverture incertaine signalée, décisions BO, retour arrière sans envoi', async () => {
    const service = await svc();
    // Désactivation Stripe déclarée le 2034-09-10 à 10 h.
    await sql`UPDATE annual_renewal_reminder_state SET stripe_reminders_disabled_at = NULL, coverage_from = NULL WHERE id = 1`;
    const decl = await service.declareStripeRemindersDisabled({ adminId, disabledAt: paris('2034-09-10', 10), now: paris('2034-09-10', 10, 5) });
    expect(decl).toMatchObject({ ok: true, coverageFrom: '2034-09-11' });
    const avant = await titulaire({ end: paris('2034-09-15', 10) }); // J−7 le 8/09 : Stripe actif ce jour-là, envoi non prouvé
    const jour = await titulaire({ end: paris('2034-09-17', 10) }); // J−7 le 10/09 : jour de la désactivation
    const apres = await titulaire({ end: paris('2034-09-18', 10) }); // J−7 le 11/09 : couvert par Verebona
    await run(paris('2034-09-11', 8, 30));
    expect(await jobsOf(avant.subId)).toHaveLength(0);
    expect(await jobsOf(jour.subId)).toHaveLength(0);
    expect(await jobsOf(apres.subId)).toHaveLength(1);
    const unc = await sql<{ stripe_subscription_id: string; outcome: string }[]>`
      SELECT stripe_subscription_id, outcome FROM annual_renewal_reminder_checks WHERE stripe_subscription_id IN (${avant.subId}, ${jour.subId}) ORDER BY renewal_date`;
    expect(unc.map((x) => x.outcome)).toEqual(['COVERAGE_UNCERTAIN', 'COVERAGE_UNCERTAIN']);
    const ov = await service.getAnnualRenewalOverview(paris('2034-09-11', 9));
    expect(ov.anomalies.filter((x) => x.state === 'COVERAGE_UNCERTAIN').map((x) => x.accountId).sort()).toEqual([avant.id, jour.id].sort());
    // Pas de nouvelle vérification ni d'envoi automatique le lendemain.
    await run(paris('2034-09-12', 8, 30));
    expect(await jobsOf(avant.subId)).toHaveLength(0);

    // Décisions BO : rappel Stripe constaté pour l'un, rappel Verebona pour l'autre.
    const { POST } = await import('@/app/api/admin/communications/annual-renewal/route');
    const cookie = await adminCookie();
    const keyOf = (s: string, d: string) => `annual-renewal-reminder:${s}:${d}`;
    expect((await POST(req('/api/admin/communications/annual-renewal', { cookie, body: { action: 'coverage', key: keyOf(avant.subId, '2034-09-15'), decision: 'STRIPE_CONFIRMED' } }))).status).toBe(200);
    // « Envoyer le rappel Verebona » revalide le calendrier à l'heure réelle : horloge du test.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(paris('2034-09-12', 10));
    let rsStatus = 0;
    try {
      const rs = await POST(req('/api/admin/communications/annual-renewal', { cookie: await adminCookie(), body: { action: 'coverage', key: keyOf(jour.subId, '2034-09-17'), decision: 'SEND_VEREBONA' } }));
      rsStatus = rs.status;
    } finally {
      vi.useRealTimers();
    }
    expect(rsStatus).toBe(200);
    expect(await jobsOf(avant.subId)).toHaveLength(0);
    const [jj] = await jobsOf(jour.subId);
    expect(jj.status).toBe('pending');

    // Retour arrière : refusé tant que la tâche est active ; puis demandes en attente neutralisées.
    const rb1 = await POST(req('/api/admin/communications/annual-renewal', { cookie, body: { action: 'rollback' } }));
    expect(rb1.status).toBe(409);
    const runner = await import('@/services/scheduling/scheduled-task-runner');
    await runner.setTaskAdminDisabled(TASK, true, adminId);
    const rb2 = await POST(req('/api/admin/communications/annual-renewal', { cookie, body: { action: 'rollback' } }));
    expect(rb2.status).toBe(200);
    expect((await rb2.json()).result.neutralized).toBeGreaterThanOrEqual(2);
    expect((await jobsOf(jour.subId))[0]).toMatchObject({ status: 'cancelled', last_error: 'ROLLBACK_NEUTRALIZED' });
    expect((await jobsOf(apres.subId))[0]).toMatchObject({ status: 'cancelled', last_error: 'ROLLBACK_NEUTRALIZED' });
    // Réactivation accidentelle de la tâche : la bascule n'est plus déclarée → rien.
    await runner.setTaskAdminDisabled(TASK, false, adminId);
    expect((await run(paris('2034-09-12', 9, 30))).skipped).toBe('SWITCH_NOT_DECLARED');
    const { runTransactionalEmailRetry } = await jobs();
    mail.clock = paris('2034-09-12', 9, 31);
    await runTransactionalEmailRetry({ now: () => paris('2034-09-12', 9, 31), limit: 500 });
    for (const x of [avant, jour, apres]) expect(mailsTo(x.email)).toHaveLength(0);
  });

  it('RJ7F-E2E-10 — réconciliation planifiée : désynchronisations corrigées par subscription-sync, absents signalés', async () => {
    const { runAnnualRenewalReconciliation } = await import('@/services/billing/annual-renewal-reconcile.service');
    // Local « mensuel » (webhook manqué) mais annuel chez Stripe : le rappel serait omis silencieusement.
    const t = await titulaire({ end: paris('2034-10-20', 10), localPeriod: 'monthly' });
    // Local « résilié » mais reconduction réactivée chez Stripe.
    const u = await titulaire({ end: paris('2034-10-20', 11), localCancel: true });
    // Abonnement annuel Stripe sans compte local.
    const orphan = `sub_${uid('orph')}`;
    etat.subs.set(orphan, stripeSub({ id: orphan, customer: `cus_${uid('orph')}`, end: paris('2034-10-19', 10) }));
    // Hors fenêtre : ignoré (aucun appel de synchronisation).
    const far = await titulaire({ end: paris('2034-12-20', 10), localPeriod: 'monthly' });

    expect((await run(paris('2034-10-13', 8, 0))).candidates).toBe(0); // hors fenêtre d'envoi
    const before = await run(paris('2034-10-13', 8, 30));
    expect(before.candidates).toBe(0); // pré-filtre local : omission silencieuse avant correction

    const r = await runAnnualRenewalReconciliation({ now: paris('2034-10-13', 7, 45), stripe: fakeStripe as never, deadline: Date.now() + 60_000 });
    expect(r).toMatchObject({ complete: true });
    expect(r.resynced).toBeGreaterThanOrEqual(2);
    expect(r.stripeOnly).toBeGreaterThanOrEqual(1);
    const [lt] = await sql<{ billing_period: string }[]>`SELECT billing_period FROM account_subscriptions WHERE account_id = ${t.id}`;
    expect(lt.billing_period).toBe('yearly');
    const [lu] = await sql<{ cancel_at_period_end: boolean }[]>`SELECT cancel_at_period_end FROM account_subscriptions WHERE account_id = ${u.id}`;
    expect(lu.cancel_at_period_end).toBe(false);
    const [lf] = await sql<{ billing_period: string }[]>`SELECT billing_period FROM account_subscriptions WHERE account_id = ${far.id}`;
    expect(lf.billing_period).toBe('monthly');
    const [o] = await sql<{ outcome: string; account_id: number | null }[]>`SELECT outcome, account_id FROM annual_renewal_reminder_checks WHERE stripe_subscription_id = ${orphan}`;
    expect(o).toEqual({ outcome: 'STRIPE_ONLY', account_id: null });
    const [kt] = await sql<{ outcome: string }[]>`SELECT outcome FROM annual_renewal_reminder_checks WHERE stripe_subscription_id = ${t.subId}`;
    expect(kt.outcome).toBe('DESYNC_RESYNCED');

    await run(paris('2034-10-13', 9, 30));
    expect(await jobsOf(t.subId)).toHaveLength(1);
    expect(await jobsOf(u.subId)).toHaveLength(1);
    const [st] = await sql<{ last_reconcile_at: Date | null }[]>`SELECT last_reconcile_at FROM annual_renewal_reminder_state WHERE id = 1`;
    expect(st.last_reconcile_at).not.toBeNull();

    // Résiliation depuis Stripe (webhook manqué) : la réconciliation la répercute, plus de rappel.
    const w = await titulaire({ end: paris('2034-10-25', 10) });
    (etat.subs.get(w.subId) as unknown as { cancel_at_period_end: boolean }).cancel_at_period_end = true;
    await runAnnualRenewalReconciliation({ now: paris('2034-10-18', 7, 45), stripe: fakeStripe as never, deadline: Date.now() + 60_000 });
    const [lw] = await sql<{ cancel_at_period_end: boolean }[]>`SELECT cancel_at_period_end FROM account_subscriptions WHERE account_id = ${w.id}`;
    expect(lw.cancel_at_period_end).toBe(true);
    await run(paris('2034-10-18', 8, 30));
    expect(await jobsOf(w.subId)).toHaveLength(0);
    etat.subs.delete(orphan);
  });

  it('RJ7F-E2E-11 — double exécution simultanée (traitements, envois, reprise) : aucun doublon', async () => {
    const t = await titulaire({ end: paris('2034-11-20', 10) });
    const now = paris('2034-11-13', 8, 30);
    await Promise.all([run(now), run(now), run(now)]);
    const [job, ...autres] = await jobsOf(t.subId);
    expect(autres).toHaveLength(0);
    mail.next.push('lose-response');
    const { runTransactionalEmailRetry } = await jobs();
    mail.clock = paris('2034-11-13', 8, 31);
    await Promise.all([send(job.id, paris('2034-11-13', 8, 31)), send(job.id, paris('2034-11-13', 8, 31))]);
    await Promise.all([
      runTransactionalEmailRetry({ now: () => paris('2034-11-13', 8, 35), limit: 500 }),
      runTransactionalEmailRetry({ now: () => paris('2034-11-13', 8, 35), limit: 500 }),
    ]);
    await run(paris('2034-11-14', 8, 30));
    expect(mailsTo(t.email)).toHaveLength(1);
    expect((await jobsOf(t.subId))[0].status).toBe('accepted');
  });

  it('RJ7F-E2E-12 — BO : états distincts, planificateur, couverture ; aucune donnée Stripe sensible', async () => {
    const pending = await titulaire({ end: paris('2034-12-20', 10) });
    const accepted = await titulaire({ end: paris('2034-12-20', 11) });
    const cancelled = await titulaire({ end: paris('2034-12-20', 12) });
    const monthly = await titulaire({ end: paris('2034-12-20', 13) });
    etat.subs.set(monthly.subId, stripeSub({ id: monthly.subId, customer: monthly.customer, end: paris('2034-12-20', 13), interval: 'month' }));
    await run(paris('2034-12-13', 8, 30));
    const [ja] = await jobsOf(accepted.subId);
    await send(ja.id, paris('2034-12-13', 8, 31));
    const [jc] = await jobsOf(cancelled.subId);
    (etat.subs.get(cancelled.subId) as unknown as { cancel_at_period_end: boolean }).cancel_at_period_end = true;
    await send(jc.id, paris('2034-12-13', 8, 31));
    // Livraison confirmée par webhook pour l'e-mail accepté.
    const { recordResendEvent } = await import('@/services/email/email-provider-events.service');
    await recordResendEvent(`evt_${uid('w')}`, { type: 'email.delivered', created_at: paris('2034-12-13', 8, 32).toISOString(), data: { email_id: mailsTo(accepted.email)[0].id } } as never);

    const { GET } = await import('@/app/api/admin/communications/email-logs/route');
    const o = await (await GET(req('/api/admin/communications/email-logs?annualRenewal=1', { method: 'GET', cookie: await adminCookie() }))).json();
    const a = o.annualRenewal;
    expect(a.scheduler).toMatchObject({ code: TASK, suspended: false });
    expect(a.switch).toMatchObject({ declared: true });
    expect(a.coverageFrom).toBe('2033-12-31');
    const stateOf = (id: number) => a.recent.find((r: { accountId: number }) => r.accountId === id)?.state;
    expect(stateOf(pending.id)).toBe('PREPARED');
    expect(stateOf(accepted.id)).toBe('DELIVERED');
    expect(stateOf(cancelled.id)).toBe('CANCELLED');
    expect(stateOf(monthly.id)).toBe('EXCLUDED');
    const txt = JSON.stringify(a);
    expect(txt).not.toContain('billing.stripe.com');
    expect(txt).not.toContain(pending.customer);
    expect(txt).not.toMatch(/re_e2e_simule/);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // LOT 76D — risques résiduels de doublon, rollback fiabilisé (scénarios 2035)
  // ══════════════════════════════════════════════════════════════════════════

  const KIND = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER';
  /** E-mails Resend portant l'étiquette de CETTE demande (bruit exclu). */
  const mailsOfJob = (jobId: number) => mail.sent.filter((m) => (m.tags ?? []).some((t) => t.name === 'vb_email_job' && t.value === String(jobId)));
  /** Autres e-mails (autres demandes) au même destinataire, plus récents que l'e-mail recherché. */
  const bruit = (to: string, n: number, at: Date) => {
    for (let i = 0; i < n; i += 1) {
      mail.sent.push({ id: `em_76d_bruit_${uid('b')}`, to, subject: 'Autre e-mail', html: '', text: '', tags: [{ name: 'vb_email_job', value: String(900_000_000 + i) }], created_at: new Date(at.getTime() + i * 1000).toISOString() });
    }
  };
  const jobRow = async (id: number) => (await sql<{ status: string; last_error: string | null; provider_outcome: string | null; provider_detail: string | null; neutralized_at: Date | null; send_generation: number }[]>`
    SELECT status, last_error, provider_outcome, provider_detail, neutralized_at, send_generation FROM transactional_email_jobs WHERE id = ${id}`)[0];
  /** Demande préparée puis appel Resend dont la réponse est perdue (acceptation incertaine, demande « pending »). */
  async function demandeIncertaine(end: Date, prep: Date) {
    const t = await titulaire({ end });
    await run(prep);
    const [job] = await jobsOf(t.subId);
    mail.next.push('lose-response');
    await send(job.id, new Date(prep.getTime() + 60_000));
    return { t, job };
  }
  /**
   * Hygiène : le retour arrière est GLOBAL. Les incertitudes laissées par d'autres scénarios du même
   * fichier ou de la même base sont arbitrées (décision BO « Abandonner ») pour que la fin du retour
   * arrière ne dépende que des données de ce test. Assertions toujours limitées à NOS demandes.
   */
  async function arbitrerLesAutres(mine: number[], now: Date) {
    const others = await sql<{ id: number }[]>`SELECT id FROM transactional_email_jobs WHERE kind = ${KIND} AND status = 'uncertain' AND NOT (id = ANY(${mine}))`;
    const { decideUncertainEmailJob } = await jobs();
    for (const o of others) await decideUncertainEmailJob(o.id, 'ABANDON', now);
  }
  const blockersOf = (p: { blockers: Array<{ kind: string; jobId: number | null }> }, jobId: number) => p.blockers.filter((b) => b.jobId === jobId).map((b) => b.kind);

  it('RJ7R-E2E-01 — e-mail accepté placé après le 20ᵉ candidat Resend : retrouvé, aucun doublon', async () => {
    const { t, job } = await demandeIncertaine(paris('2035-01-20', 10), paris('2035-01-13', 8, 30));
    expect(mailsOfJob(job.id)).toHaveLength(1);
    // 25 autres e-mails au même destinataire, plus récents : l'e-mail recherché est le 26ᵉ candidat.
    bruit(t.email, 25, paris('2035-01-13', 8, 40));
    // Au-delà de la fenêtre d'idempotence : consultation Resend.
    expect(await send(job.id, paris('2035-01-14', 10, 40))).toMatchObject({ status: 'accepted' });
    expect(mailsOfJob(job.id)).toHaveLength(1);
    expect(await jobRow(job.id)).toMatchObject({ status: 'accepted', provider_outcome: 'reconciled', send_generation: 0 });
  });

  it('RJ7R-E2E-02 — recherche tronquée (candidats, pages, durée) ou consultation en échec : unknown, réémission bloquée', async () => {
    const { reconcileProviderCall, runTransactionalEmailRetry, decideUncertainEmailJob, PROVIDER_LOOKUP_MAX_CANDIDATES } = await jobs();
    // a) Plus de candidats que la limite d'inspection : jamais « absent ».
    const a = await demandeIncertaine(paris('2035-02-20', 10), paris('2035-02-13', 8, 30));
    bruit(a.t.email, PROVIDER_LOOKUP_MAX_CANDIDATES + 10, paris('2035-02-13', 8, 40));
    expect(await send(a.job.id, paris('2035-02-14', 10, 40))).toMatchObject({ status: 'uncertain' });
    const ra = await jobRow(a.job.id);
    expect(ra).toMatchObject({ status: 'uncertain', provider_outcome: 'uncertain', send_generation: 0 });
    expect(ra.provider_detail).toMatch(/RESEND_CANDIDATES_LIMIT/);
    await runTransactionalEmailRetry({ now: () => paris('2035-02-14', 10, 45), limit: 500 });
    expect(mailsOfJob(a.job.id)).toHaveLength(1);

    // b) Limite de pages et c) limite de durée : unknown avec motif, jamais « absent ».
    const probe = { id: 987_654_321, recipient_email: `absent-${uid('l76')}@test.invalid`, send_generation: 0, provider_call_started_at: paris('2035-02-13', 8, 31) };
    bruit(`autre-${uid('l76')}@test.invalid`, 150, paris('2035-02-13', 8, 50));
    const full = await reconcileProviderCall(probe, paris('2035-02-14', 10, 40), { providerLookup: true });
    expect(full.kind).toBe('absent'); // témoin : recherche complète
    expect(await reconcileProviderCall(probe, paris('2035-02-14', 10, 40), { providerLookup: true, budget: { maxPages: 1 } }))
      .toEqual({ kind: 'unknown', detail: expect.stringMatching(/RESEND_LISTING_PAGE_LIMIT/) });
    expect(await reconcileProviderCall(probe, paris('2035-02-14', 10, 40), { providerLookup: true, budget: { maxMs: 0 } }))
      .toEqual({ kind: 'unknown', detail: expect.stringMatching(/RESEND_LOOKUP_TIMEOUT/) });

    // d) Consultation d'un candidat en échec : incertitude conservée, réémission bloquée.
    const d = await demandeIncertaine(paris('2035-02-21', 10), paris('2035-02-14', 8, 30));
    bruit(d.t.email, 3, paris('2035-02-14', 8, 40));
    // L'e-mail recherché lui-même ne peut pas être consulté (les autres candidats, si).
    mail.getFail.add(mailsOfJob(d.job.id)[0].id);
    expect(await send(d.job.id, paris('2035-02-15', 10, 40))).toMatchObject({ status: 'uncertain' });
    expect((await jobRow(d.job.id)).provider_detail).toMatch(/RESEND_LOOKUP_internal_server_error/);
    await runTransactionalEmailRetry({ now: () => paris('2035-02-15', 10, 45), limit: 500 });
    expect(mailsOfJob(d.job.id)).toHaveLength(1);
    mail.getFail.clear();

    // e) Absence ÉTABLIE après recherche complète (Resend n'a rien accepté) : reprise contrôlée, un seul e-mail.
    const e = await titulaire({ end: paris('2035-02-22', 10) });
    await run(paris('2035-02-15', 8, 30));
    const [je] = await jobsOf(e.subId);
    mail.next.push('error-500-before');
    await send(je.id, paris('2035-02-15', 8, 31));
    bruit(e.email, 30, paris('2035-02-15', 8, 40));
    expect(await send(je.id, paris('2035-02-16', 10, 40))).toMatchObject({ status: 'accepted' });
    expect(mailsOfJob(je.id)).toHaveLength(1);
    expect((await jobRow(je.id)).send_generation).toBe(1);

    for (const id of [a.job.id, d.job.id]) await decideUncertainEmailJob(id, 'ABANDON', paris('2035-02-16', 11));
  });

  it('RJ7R-E2E-03 — rollback d’une demande pending à acceptation incertaine : incertitude préservée et visible, aucune réémission', async () => {
    const service = await svc();
    const { t, job } = await demandeIncertaine(paris('2035-03-20', 10), paris('2035-03-13', 8, 30));
    const ready = await titulaire({ end: paris('2035-03-20', 11) });
    await run(paris('2035-03-13', 8, 35));
    const [jr] = await jobsOf(ready.subId);
    const runner = await import('@/services/scheduling/scheduled-task-runner');
    await runner.setTaskAdminDisabled(TASK, true, adminId);
    const { POST } = await import('@/app/api/admin/communications/annual-renewal/route');
    const res = await POST(req('/api/admin/communications/annual-renewal', { cookie: await adminCookie(), body: { action: 'rollback' } }));
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result.phase).toBe('in_progress');
    expect(result.uncertain).toBeGreaterThanOrEqual(1);
    expect(blockersOf(result, job.id)).toEqual(['UNCERTAIN']);
    // Demande jamais transmise : neutralisée sans envoi. Demande à acceptation incertaine : JAMAIS « annulée ».
    expect(await jobRow(jr.id)).toMatchObject({ status: 'cancelled', last_error: 'ROLLBACK_NEUTRALIZED' });
    const r = await jobRow(job.id);
    expect(r).toMatchObject({ status: 'uncertain', provider_outcome: 'uncertain', last_error: 'ROLLBACK_UNCERTAIN' });
    expect(r.neutralized_at).not.toBeNull();
    const [k] = await sql<{ history: Array<{ step: string }> }[]>`SELECT history FROM annual_renewal_reminder_checks WHERE job_id = ${job.id}`;
    expect(k.history.map((h) => h.step)).toEqual(['ROLLBACK', 'ENQUEUE']); // historique avant / après conservé

    const ov = await service.getAnnualRenewalOverview(paris('2035-03-13', 9));
    expect(ov.anomalies.some((x) => x.jobId === job.id && x.state === 'UNCERTAIN' && x.neutralized === true)).toBe(true);
    expect(ov.recent.find((x) => x.jobId === jr.id)?.state).toBe('NEUTRALIZED');
    expect(ov.rollback).toMatchObject({ status: 'in_progress' });
    expect(blockersOf(ov.rollback!, job.id)).toEqual(['UNCERTAIN']);

    // Aucune réémission : ni la file, ni un envoi ciblé, ni la décision « réémettre ».
    const { runTransactionalEmailRetry, processEmailJob } = await jobs();
    await runTransactionalEmailRetry({ now: () => paris('2035-03-14', 12), limit: 500 });
    expect(await processEmailJob(job.id, paris('2035-03-14', 12, 1))).toMatchObject({ status: 'busy' });
    const reissue = await POST(req('/api/admin/communications/annual-renewal', { cookie: await adminCookie(), body: { action: 'job', jobId: job.id, decision: 'REISSUE' } }));
    expect(reissue.status).toBe(409);
    expect((await reissue.json()).code).toBe('NEUTRALIZED');
    expect(mailsOfJob(job.id)).toHaveLength(1);
    expect(mailsTo(ready.email)).toHaveLength(0);
    // Finalisation impossible tant que l'incertitude n'est pas arbitrée.
    expect(await service.finalizeAnnualRenewalRollback({ adminId, acknowledgeNotified: true, now: paris('2035-03-14', 12, 2) })).toMatchObject({ ok: false, code: 'BLOCKED' });
    void t;

    // Arbitrage explicite (« Abandonner ») : clos, l'incertitude reste tracée (jamais « annulé sans envoi »).
    await arbitrerLesAutres([job.id], paris('2035-03-14', 12, 3));
    expect((await POST(req('/api/admin/communications/annual-renewal', { cookie: await adminCookie(), body: { action: 'job', jobId: job.id, decision: 'ABANDON' } }))).status).toBe(200);
    const p = await service.advanceAnnualRenewalRollback({ now: paris('2035-03-14', 12, 4) });
    expect(p.phase).toBe('completed');
    expect(await jobRow(job.id)).toMatchObject({ status: 'cancelled', provider_outcome: 'uncertain' });
    const ov2 = await service.getAnnualRenewalOverview(paris('2035-03-14', 12, 5));
    expect(ov2.recent.find((x) => x.jobId === job.id)?.state).toBe('CANCELLED_UNCERTAIN');
    expect(ov2.rollback).toMatchObject({ status: 'completed', completionMode: 'auto' });
  });

  it('RJ7R-E2E-04 — rollback pendant un appel Resend : « en cours » jusqu’à résolution, puis arbitrage des échéances notifiées', async () => {
    const service = await svc();
    const t = await titulaire({ end: paris('2035-04-20', 10) });
    await run(paris('2035-04-13', 8, 30));
    const [job] = await jobsOf(t.subId);
    let called!: () => void;
    const callStarted = new Promise<void>((r) => { called = r; });
    let release!: () => void;
    mail.gate = new Promise<void>((r) => { release = r; });
    mail.onSendStart = called;
    const sending = send(job.id, paris('2035-04-13', 8, 31));
    await callStarted; // appel Resend engagé
    const runner = await import('@/services/scheduling/scheduled-task-runner');
    await runner.setTaskAdminDisabled(TASK, true, adminId);
    const rb = await service.rollbackToStripeReminders({ adminId, now: paris('2035-04-13', 8, 32) });
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;
    expect(rb.result.phase).toBe('in_progress');
    expect(blockersOf(rb.result, job.id)).toEqual(['IN_FLIGHT']);
    const p1 = await service.advanceAnnualRenewalRollback({ now: paris('2035-04-13', 8, 32) });
    expect(p1.phase).toBe('in_progress');
    expect(blockersOf(p1, job.id)).toEqual(['IN_FLIGHT']);
    expect(await service.finalizeAnnualRenewalRollback({ adminId, acknowledgeNotified: true, now: paris('2035-04-13', 8, 32) })).toMatchObject({ ok: false, code: 'BLOCKED' });
    // Une nouvelle bascule est refusée pendant le retour arrière.
    expect(await service.declareStripeRemindersDisabled({ adminId, disabledAt: paris('2035-04-13', 8, 32), now: paris('2035-04-13', 8, 33) })).toMatchObject({ ok: false, code: 'ROLLBACK_IN_PROGRESS' });

    release();
    expect(await sending).toMatchObject({ status: 'accepted' });
    await arbitrerLesAutres([job.id], paris('2035-04-13', 8, 33));
    const p2 = await service.advanceAnnualRenewalRollback({ now: paris('2035-04-13', 8, 33) });
    // Échéance déjà notifiée par Verebona : réactiver Stripe peut produire un second rappel → arbitrage explicite.
    expect(p2.phase).toBe('in_progress');
    expect(blockersOf(p2, job.id)).toEqual(['NOTIFIED']);
    expect(await service.finalizeAnnualRenewalRollback({ adminId, acknowledgeNotified: false, now: paris('2035-04-13', 8, 34) })).toMatchObject({ ok: false, code: 'ACK_REQUIRED' });
    const { POST } = await import('@/app/api/admin/communications/annual-renewal/route');
    const fin = await POST(req('/api/admin/communications/annual-renewal', { cookie: await adminCookie(), body: { action: 'rollback-finalize', acknowledgeNotified: true } }));
    expect(fin.status).toBe(200);
    const st = (await service.getAnnualRenewalOverview(paris('2035-04-13', 8, 35))).rollback;
    expect(st).toMatchObject({ status: 'completed', completionMode: 'admin_ack', completedBy: adminId });
    expect(mailsOfJob(job.id)).toHaveLength(1);
  });

  it('RJ7R-E2E-05 — crash pendant le rollback / verrou expiré : réconciliation sans réémission ; incertitude bloque la fin', async () => {
    const service = await svc();
    const { decideUncertainEmailJob } = await jobs();
    const a = await demandeIncertaine(paris('2035-05-20', 10), paris('2035-05-13', 8, 30));
    const b = await demandeIncertaine(paris('2035-05-21', 10), paris('2035-05-14', 8, 30));
    // Arrêt du processus pendant une reprise : demandes restées « sending », verrou expiré.
    for (const j of [a.job, b.job]) await sql`UPDATE transactional_email_jobs SET status = 'sending', locked_until = ${paris('2035-05-14', 8, 40).toISOString()} WHERE id = ${j.id}`;
    const runner = await import('@/services/scheduling/scheduled-task-runner');
    await runner.setTaskAdminDisabled(TASK, true, adminId);
    const rb = await service.rollbackToStripeReminders({ adminId, now: paris('2035-05-14', 9) });
    if (!rb.ok) throw new Error('rollback refusé');
    expect(blockersOf(rb.result, a.job.id)).toEqual(['TO_RECONCILE']);
    // Le verrou expiré ne permet ni reprise par la file ni envoi ciblé.
    const { runTransactionalEmailRetry, processEmailJob } = await jobs();
    await runTransactionalEmailRetry({ now: () => paris('2035-05-14', 9, 1), limit: 500 });
    expect(await processEmailJob(a.job.id, paris('2035-05-14', 9, 1))).toMatchObject({ status: 'busy' });
    // Réconciliation (consultation seule) : a retrouvé chez Resend ; b consultation en échec → incertain.
    mail.getFail.add(mailsOfJob(b.job.id)[0].id);
    await arbitrerLesAutres([a.job.id, b.job.id], paris('2035-05-14', 9, 14));
    const p = await service.advanceAnnualRenewalRollback({ now: paris('2035-05-14', 9, 15) });
    expect(await jobRow(a.job.id)).toMatchObject({ status: 'accepted', provider_outcome: 'reconciled' });
    expect(await jobRow(b.job.id)).toMatchObject({ status: 'uncertain', provider_outcome: 'uncertain' });
    expect(blockersOf(p, a.job.id)).toEqual(['NOTIFIED']);
    expect(blockersOf(p, b.job.id)).toEqual(['UNCERTAIN']);
    expect(await service.finalizeAnnualRenewalRollback({ adminId, acknowledgeNotified: true, now: paris('2035-05-14', 9, 16) })).toMatchObject({ ok: false, code: 'BLOCKED' });
    // « Vérifier de nouveau » : consultation seulement, toujours incertain, jamais d'envoi.
    expect(await decideUncertainEmailJob(b.job.id, 'RECHECK', paris('2035-05-14', 9, 17))).toMatchObject({ ok: true });
    await service.advanceAnnualRenewalRollback({ now: paris('2035-05-14', 9, 18) });
    expect((await jobRow(b.job.id)).status).toBe('uncertain');
    for (const j of [a.job, b.job]) expect(mailsOfJob(j.id)).toHaveLength(1);
    mail.getFail.clear();
    // Arbitrage : b abandonné ; a notifiée → fin avec arbitrage explicite.
    expect(await decideUncertainEmailJob(b.job.id, 'ABANDON', paris('2035-05-14', 9, 19))).toMatchObject({ ok: true });
    expect(await service.finalizeAnnualRenewalRollback({ adminId, acknowledgeNotified: true, now: paris('2035-05-14', 9, 20) })).toMatchObject({ ok: true });

    // Bascule redéclarée plus tard et tâche réactivée : aucune demande neutralisée n'est réémise.
    expect(await service.declareStripeRemindersDisabled({ adminId, disabledAt: paris('2035-05-15', 7), now: paris('2035-05-15', 7, 5) })).toMatchObject({ ok: true });
    await runner.setTaskAdminDisabled(TASK, false, adminId);
    await run(paris('2035-05-15', 8, 30));
    await runTransactionalEmailRetry({ now: () => paris('2035-05-15', 8, 31), limit: 500 });
    for (const j of [a.job, b.job]) expect(mailsOfJob(j.id)).toHaveLength(1);
    expect(await jobsOf(b.t.subId)).toHaveLength(1);
  });

  it('RJ7R-E2E-06 — rollback concurrent avec une reprise de file et un second rollback : neutralisation respectée, état final cohérent', async () => {
    const service = await svc();
    const { runTransactionalEmailRetry, processEmailJob, decideUncertainEmailJob } = await jobs();
    const c1 = await titulaire({ end: paris('2035-06-20', 10) });
    const c2 = await titulaire({ end: paris('2035-06-20', 11) });
    const c3 = await demandeIncertaine(paris('2035-06-20', 12), paris('2035-06-13', 8, 30));
    await run(paris('2035-06-13', 8, 35));
    const [j1] = await jobsOf(c1.subId);
    const [j2] = await jobsOf(c2.subId);
    let called!: () => void;
    const callStarted = new Promise<void>((r) => { called = r; });
    let release!: () => void;
    mail.gate = new Promise<void>((r) => { release = r; });
    mail.onSendStart = called;
    const sending = send(j1.id, paris('2035-06-13', 8, 36));
    await callStarted;
    const runner = await import('@/services/scheduling/scheduled-task-runner');
    await runner.setTaskAdminDisabled(TASK, true, adminId);
    // Consultation Resend indisponible : l'issue de c3 reste incertaine quel que soit l'ordre d'exécution.
    mail.listForbidden = true;
    const at = paris('2035-06-13', 8, 37);
    const [r1, r2] = await Promise.all([
      service.rollbackToStripeReminders({ adminId, now: at }),
      service.rollbackToStripeReminders({ adminId, now: at }),
      runTransactionalEmailRetry({ now: () => at, limit: 500 }),
      runTransactionalEmailRetry({ now: () => at, limit: 500 }),
      processEmailJob(j2.id, at),
      processEmailJob(c3.job.id, at),
      service.advanceAnnualRenewalRollback({ now: at }),
      decideUncertainEmailJob(c3.job.id, 'RECHECK', at),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    release();
    expect(await sending).toMatchObject({ status: 'accepted' });
    await service.advanceAnnualRenewalRollback({ now: paris('2035-06-13', 8, 45) });
    const [st] = await sql<{ rollback_status: string; stripe_reminders_disabled_at: Date | null }[]>`SELECT rollback_status, stripe_reminders_disabled_at FROM annual_renewal_reminder_state WHERE id = 1`;
    expect(st).toMatchObject({ rollback_status: 'in_progress', stripe_reminders_disabled_at: null });
    expect(await jobRow(j1.id)).toMatchObject({ status: 'accepted' });
    const r2row = await jobRow(j2.id);
    expect(r2row).toMatchObject({ status: 'cancelled', last_error: 'ROLLBACK_NEUTRALIZED' });
    expect(r2row.neutralized_at).not.toBeNull();
    expect((await jobRow(c3.job.id)).status).toBe('uncertain');
    // Reprises répétées : rien ne repart.
    for (let i = 0; i < 3; i += 1) await runTransactionalEmailRetry({ now: () => paris('2035-06-13', 9 + i), limit: 500 });
    expect(mailsOfJob(j1.id)).toHaveLength(1);
    expect(mailsTo(c2.email)).toHaveLength(0);
    expect(mailsOfJob(c3.job.id)).toHaveLength(1);
    mail.listForbidden = false;
    await decideUncertainEmailJob(c3.job.id, 'ABANDON', paris('2035-06-13', 12));
    await arbitrerLesAutres([], paris('2035-06-13', 12));
    expect(await service.finalizeAnnualRenewalRollback({ adminId, acknowledgeNotified: true, now: paris('2035-06-13', 12, 1) })).toMatchObject({ ok: true });
  });

  it('RJ7R-E2E-07 — autres e-mails transactionnels pendant la suspension et le rollback : aucun blocage', async () => {
    const service = await svc();
    const pend = await demandeIncertaine(paris('2035-07-20', 10), paris('2035-07-13', 8, 30));
    const runner = await import('@/services/scheduling/scheduled-task-runner');
    await runner.setTaskAdminDisabled(TASK, true, adminId);
    const rb = await service.rollbackToStripeReminders({ adminId, now: paris('2035-07-13', 9) });
    expect(rb.ok && rb.result.phase).toBe('in_progress');
    const verifEmail = `verif-76d-${uid('l76')}@test.invalid`;
    const u = await make.user({ email: verifEmail });
    await sql`UPDATE users SET is_active = false, first_name = 'Vera' WHERE id = ${u.id}`;
    const { enqueueVerificationEmail } = await jobs();
    const v = await enqueueVerificationEmail({ userId: u.id, email: verifEmail });
    // Tâche planifiée réelle (file + contrôle du retour arrière) : l'e-mail de vérification part.
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const task = SCHEDULED_TASKS.find((x) => x.code === 'transactional-emails-retry')!;
    mail.clock = new Date();
    await task.run({ deadline: Date.now() + 30_000 } as never);
    expect(mailsTo(verifEmail)).toHaveLength(1);
    const [vj] = await sql<{ status: string }[]>`SELECT status FROM transactional_email_jobs WHERE id = ${v.jobId}`;
    expect(vj.status).toBe('accepted');
    expect(mailsOfJob(pend.job.id)).toHaveLength(1);
    expect((await jobRow(pend.job.id)).status).toBe('uncertain');
    await (await jobs()).decideUncertainEmailJob(pend.job.id, 'ABANDON', paris('2035-07-13', 10));
  });

  it('RJ7R-E2E-08 — local actif, Stripe past_due / unpaid / canceled / paused : divergence détectée, synchronisation vérifiée, aucun rappel', async () => {
    const { runAnnualRenewalReconciliation } = await import('@/services/billing/annual-renewal-reconcile.service');
    const cas = {} as Record<'past_due' | 'unpaid' | 'canceled' | 'paused', Awaited<ReturnType<typeof titulaire>>>;
    let h = 9;
    for (const s of ['past_due', 'unpaid', 'canceled', 'paused'] as const) {
      const t = await titulaire({ end: paris('2035-08-20', h++) });
      (etat.subs.get(t.subId) as unknown as { status: string }).status = s;
      cas[s] = t;
    }
    const r = await runAnnualRenewalReconciliation({ now: paris('2035-08-13', 7, 45), stripe: fakeStripe as never, deadline: Date.now() + 60_000 });
    expect(r.complete).toBe(true);
    const local = async (id: number) => (await sql<{ status: string }[]>`SELECT status FROM account_subscriptions WHERE account_id = ${id}`)[0].status;
    expect(await local(cas.past_due.id)).toBe('past_due');
    expect(await local(cas.unpaid.id)).toBe('canceled');
    expect(await local(cas.canceled.id)).toBe('canceled');
    const outcome = async (subId: string) => (await sql<{ outcome: string; reason: string }[]>`SELECT outcome, reason FROM annual_renewal_reminder_checks WHERE stripe_subscription_id = ${subId} AND candidate_key LIKE 'annual-renewal-reminder:%'`)[0];
    for (const s of ['past_due', 'unpaid', 'canceled'] as const) expect(await outcome(cas[s].subId)).toMatchObject({ outcome: 'DESYNC_RESYNCED', reason: expect.stringContaining('STATUS') });
    // paused : subscription-sync n'écrit pas cet état → divergence PERSISTANTE journalisée.
    expect(await outcome(cas.paused.subId)).toMatchObject({ outcome: 'DESYNC_UNRESOLVED', reason: expect.stringContaining('STATUS') });
    await run(paris('2035-08-13', 8, 30));
    for (const s of Object.values(cas)) expect(await jobsOf(s.subId)).toHaveLength(0);
    for (const s of Object.values(cas)) etat.subs.delete(s.subId);
  });

  it('RJ7R-E2E-09 — erreur Stripe dans le parcours inverse : trace individuelle persistante, BO, reprise qui clôt en conservant l’historique', async () => {
    const service = await svc();
    const { runAnnualRenewalReconciliation, describeReconcileRun } = await import('@/services/billing/annual-renewal-reconcile.service');
    const t = await titulaire({ end: paris('2035-09-20', 10) });
    (etat.subs.get(t.subId) as unknown as { status: string }).status = 'past_due';
    etat.failRetrieve.set(t.subId, Object.assign(new Error('Invalid API Key provided: sk_live_76dSECRET1234 (https://billing.stripe.com/p/session/test_76d)'), { type: 'StripeAuthenticationError', statusCode: 401 }));
    const r = await runAnnualRenewalReconciliation({ now: paris('2035-09-13', 7, 45), stripe: fakeStripe as never, deadline: Date.now() + 60_000 });
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(describeReconcileRun(r).error).toBeTruthy(); // jamais présenté comme une réconciliation complète réussie
    const [k] = await sql<{ candidate_key: string; outcome: string; account_id: number; renewal_date: string; renewal_date_verified: boolean; step: string; reason: string; last_checked_at: Date; next_check_at: Date; history: unknown[] }[]>`
      SELECT candidate_key, outcome, account_id, renewal_date::text, renewal_date_verified, step, reason, last_checked_at, next_check_at, history
        FROM annual_renewal_reminder_checks WHERE stripe_subscription_id = ${t.subId} AND outcome = 'RECONCILE_ERROR'`;
    expect(k).toMatchObject({ account_id: t.id, renewal_date: '2035-09-20', renewal_date_verified: false, step: 'RECONCILE_REVERSE' });
    expect(new Date(k.last_checked_at).toISOString()).toBe(paris('2035-09-13', 7, 45).toISOString());
    expect(new Date(k.next_check_at).toISOString()).toBe(paris('2035-09-14', 7, 40).toISOString());
    expect(k.reason).toMatch(/StripeAuthenticationError/);
    expect(k.reason).not.toMatch(/sk_live_76dSECRET|billing\.stripe\.com/);
    const ov = await service.getAnnualRenewalOverview(paris('2035-09-13', 9));
    const an = ov.anomalies.find((x) => x.key === k.candidate_key);
    expect(an).toMatchObject({ state: 'RECONCILE_ERROR', accountId: t.id, renewalDate: '2035-09-20', nextAt: paris('2035-09-14', 7, 40).toISOString() });
    const { GET } = await import('@/app/api/admin/communications/email-logs/route');
    const txt = JSON.stringify(await (await GET(req('/api/admin/communications/email-logs?annualRenewal=1', { method: 'GET', cookie: await adminCookie() }))).json());
    expect(txt).toContain(k.candidate_key);
    expect(txt).not.toMatch(/sk_live_76dSECRET|billing\.stripe\.com/);

    // Reprise réussie le lendemain : anomalie close, historique conservé, synchronisation effectuée.
    etat.failRetrieve.delete(t.subId);
    await runAnnualRenewalReconciliation({ now: paris('2035-09-14', 7, 45), stripe: fakeStripe as never, deadline: Date.now() + 60_000 });
    const [k2] = await sql<{ outcome: string; history: Array<{ outcome: string }> }[]>`SELECT outcome, history FROM annual_renewal_reminder_checks WHERE candidate_key = ${k.candidate_key}`;
    expect(k2.outcome).toBe('RECONCILE_RESOLVED');
    expect(k2.history.map((x) => x.outcome)).toEqual(['RECONCILE_RESOLVED', 'RECONCILE_ERROR']);
    expect((await service.getAnnualRenewalOverview(paris('2035-09-14', 9))).anomalies.some((x) => x.key === k.candidate_key)).toBe(false);
    const [l] = await sql<{ status: string }[]>`SELECT status FROM account_subscriptions WHERE account_id = ${t.id}`;
    expect(l.status).toBe('past_due');
    etat.subs.delete(t.subId);
  });

  it('RJ7R-E2E-10 — migration 0585 rejouée sur un retour arrière antérieur (lot 72F) : incertitudes rendues visibles, phase « en cours », idempotente', async () => {
    const service = await svc();
    const { t, job } = await demandeIncertaine(paris('2035-10-20', 10), paris('2035-10-13', 8, 30));
    // État laissé par l'ancien code : demande incertaine « annulée », retour arrière sans phase.
    await sql`UPDATE transactional_email_jobs SET status = 'cancelled', last_error = 'ROLLBACK_NEUTRALIZED', neutralized_at = NULL WHERE id = ${job.id}`;
    await sql`UPDATE annual_renewal_reminder_state SET stripe_reminders_disabled_at = NULL, rollback_at = ${paris('2035-10-13', 9).toISOString()}, rollback_status = NULL WHERE id = 1`;
    const { readFileSync } = await import('node:fs');
    const mig = readFileSync('src/db/migrations/0585_l76d_rappel_j7_rollback.sql', 'utf8');
    for (let i = 0; i < 2; i += 1) await sql.begin(async (tx) => { await tx.unsafe(mig); }); // rejouée deux fois : idempotente
    const r = await jobRow(job.id);
    expect(r).toMatchObject({ status: 'uncertain', last_error: 'ROLLBACK_UNCERTAIN', provider_outcome: 'uncertain' });
    expect(r.neutralized_at).not.toBeNull();
    const ov = await service.getAnnualRenewalOverview(paris('2035-10-13', 10));
    expect(ov.rollback?.status).toBe('in_progress');
    expect(blockersOf(ov.rollback!, job.id)).toEqual(['UNCERTAIN']);
    expect(await service.declareStripeRemindersDisabled({ adminId, disabledAt: paris('2035-10-13', 10), now: paris('2035-10-13', 10, 1) })).toMatchObject({ ok: false, code: 'ROLLBACK_IN_PROGRESS' });
    const { decideUncertainEmailJob, runTransactionalEmailRetry } = await jobs();
    await runTransactionalEmailRetry({ now: () => paris('2035-10-14', 10), limit: 500 });
    expect(mailsOfJob(job.id)).toHaveLength(1);
    await decideUncertainEmailJob(job.id, 'ABANDON', paris('2035-10-14', 10, 1));
    await arbitrerLesAutres([job.id], paris('2035-10-14', 10, 1));
    expect((await service.advanceAnnualRenewalRollback({ now: paris('2035-10-14', 10, 2) })).phase).toBe('completed');
    void t;
  });
});
