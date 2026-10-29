/**
 * Lot 81E — écarts résiduels du lot 79C, sur PostgreSQL 16 réel, par les
 * PRODUCTEURS MÉTIER réels : route webhook Stripe (événements rejoués dans
 * tous les ordres, en double, simultanés, tardifs), synchronisation
 * d'abonnement, file durable des e-mails transactionnels, dispatcher,
 * pipeline d'analyse T1 et file durable T1, récapitulatif « À traiter ».
 * Prestataires simulés : Resend (acceptation, refus, réponse incertaine avec
 * clé d'idempotence), Stripe (abonnements relus), Web Push, modèle (rejeu).
 * Complète `l79c-notifications.e2e.ts` (décisions 79C, non-régression).
 *
 *   L81E-E2E-01 abonnement : activation par 4 webhooks simultanés, doublon et
 *               rejeu désordonné → UNE opération, UNE confirmation durable,
 *               aucun e-mail générique ;
 *   L81E-E2E-02 confirmation : refus du prestataire, reprise, réponse
 *               incertaine sans doublon, échec final supervisé au BO ;
 *   L81E-E2E-03 résiliation programmée ≠ prise d'effet ; deux transitions du
 *               même utilisateur en moins de 24 h ; producteurs multiples ;
 *               webhook tardif d'un ancien abonnement ;
 *   L81E-E2E-04 incidents de paiement : ordre, retard, doublon, concurrence,
 *               plusieurs factures, facture réglée, porteur en échec, rappels ;
 *   L81E-E2E-05 renouvellement : `receipt_number` n'est plus une preuve ;
 *   L81E-E2E-06 récapitulatif : échec non communiqué puis repris, inchangé,
 *               évolution de priorité, concurrence, plus de 1 000 comptes ;
 *   L81E-E2E-07 statuts outbox / BO fidèles ; migrations 0638 et 0640 sur
 *               données historiques ;
 *   L81E-E2E-08 lots d'analyse (pipeline réel) : réussite partielle avec
 *               reprise, échec total, reprise réussie, doublon / regroupement,
 *               deux analyses distinctes du même document, filet.
 */
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { sortieT1, useTargetState } from '../chain';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { LEGACY_PRICE_VARS } from '@/services/billing/legacy-price-env';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_l81e';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e_l81e';
  return {
    mails: [] as Array<{ id: string; to: string; subject?: string }>,
    /** Comportement du prestataire par destinataire : refus, réponse incertaine (acceptée mais 500). */
    modes: new Map<string, 'reject' | 'uncertain'>(),
    /** Clés d'idempotence déjà acceptées (Resend rend la réponse d'origine). */
    cles: new Map<string, string>(),
    n: 0,
    pushes: [] as Array<{ endpoint: string }>,
    subs: new Map<string, Record<string, unknown>>(),
  };
});
afterAll(async () => {
  delete process.env.RESEND_API_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
  const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
  setMobilePushProviderForTests(undefined);
});

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject?: string }, o?: { idempotencyKey?: string }) => {
        const cle = o?.idempotencyKey;
        if (cle && etat.cles.has(cle)) return { data: { id: etat.cles.get(cle) }, error: null };
        const mode = etat.modes.get(String(p.to));
        if (mode === 'reject') return { data: null, error: { name: 'validation_error', statusCode: 422, message: 'adresse refusée' } };
        etat.n += 1;
        const id = `em_l81e_${etat.n}`;
        etat.mails.push({ id, to: String(p.to), subject: p.subject });
        if (cle) etat.cles.set(cle, id);
        if (mode === 'uncertain') {
          etat.modes.delete(String(p.to));
          return { data: null, error: { name: 'internal_server_error', statusCode: 500, message: 'réponse perdue' } };
        }
        return { data: { id }, error: null };
      },
      get: async () => ({ data: null, error: { name: 'not_found', statusCode: 404, message: 'absent' } }),
      list: async () => ({ data: { data: [], has_more: false }, error: null }),
    };
  },
}));
// Lot 94 (décision PO M3) : plus de Web Push — push vers l'application mobile,
// fournisseur SIMULÉ (aucun appel réseau). `endpoint` = jeton de l'appareil.
const fournisseurPush = {
  name: 'fake-l81e',
  async send(m: { token: string }) {
    etat.pushes.push({ endpoint: m.token });
    return { ok: true as const, messageId: `projects/e2e/messages/${etat.pushes.length}` };
  },
};
const fakeStripe = {
  webhooks: { constructEvent: (body: string) => JSON.parse(body) },
  subscriptions: {
    retrieve: async (id: string) => {
      const s = etat.subs.get(id);
      if (!s) throw new Error(`abonnement ${id} inconnu (Stripe simulé)`);
      return structuredClone(s);
    },
    list: async () => ({ data: [] }),
    cancel: async () => ({}),
  },
  invoices: { listLineItems: async function* () { /* lignes complètes dans l'événement */ } },
  prices: { retrieve: async (id: string) => { throw new Error(`prix ${id} hors registre`); } },
};
vi.mock('@/lib/stripe', async (orig) => ({ ...(await orig<object>()), getStripeServer: () => fakeStripe }));
// Analyse : quota et crédits du compte de test non limitants.
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));

beforeAll(() => {
  for (const v of LEGACY_PRICE_VARS) {
    if (v.billingPeriod) process.env[v.name] = `price_e2e_${v.planCode}_${v.billingPeriod}`;
  }
});

const CENTS: Record<string, number> = { standard: 290, premium: 590, premium_duo: 890 };
const now = () => Math.floor(Date.now() / 1000);

function sub(o: {
  id: string; customer: string; status: Stripe.Subscription.Status; plan: 'standard' | 'premium' | 'premium_duo'; accountId: number;
  cancelAtPeriodEnd?: boolean; cancelAt?: number; canceledAt?: number; endedAt?: number; period?: 'monthly' | 'yearly';
}): Record<string, unknown> {
  const period = o.period ?? 'monthly';
  return {
    id: o.id, object: 'subscription', customer: o.customer, status: o.status,
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false, cancel_at: o.cancelAt ?? null, canceled_at: o.canceledAt ?? null,
    ended_at: o.endedAt ?? null, start_date: now() - 3600, metadata: { accountId: String(o.accountId) }, discounts: [],
    items: { data: [{
      id: `si_${o.id}`, quantity: 1,
      price: { id: `price_e2e_${o.plan}_${period}`, object: 'price', livemode: false, active: true, lookup_key: null, metadata: {}, type: 'recurring',
        unit_amount: CENTS[o.plan], currency: 'eur', product: 'prod_e2e', tax_behavior: 'inclusive',
        recurring: { interval: period === 'yearly' ? 'year' : 'month', interval_count: 1 } },
      current_period_start: now() - 3600, current_period_end: now() + 30 * 86400,
    }] },
  };
}

function facture(o: { id: string; customer: string; subId: string; reason?: string; status?: string; receipt?: string; attempted?: boolean }): Record<string, unknown> {
  return {
    id: o.id, object: 'invoice', customer: o.customer, status: o.status ?? 'open', billing_reason: o.reason ?? 'subscription_cycle',
    amount_due: 590, amount_paid: o.status === 'paid' ? 590 : 0, total: 590, currency: 'eur',
    attempted: o.attempted ?? true, attempt_count: o.attempted === false ? 0 : 1, receipt_number: o.receipt ?? null,
    status_transitions: { paid_at: o.status === 'paid' ? now() : null },
    parent: { subscription_details: { subscription: o.subId } },
    lines: { has_more: false, data: [{ amount: 590, period: { start: now(), end: now() + 30 * 86400 },
      pricing: { price_details: { price: 'price_e2e_premium_monthly' } }, price: { id: 'price_e2e_premium_monthly', recurring: { interval: 'month' } } }] },
  };
}

let evtN = 0;
async function webhook(type: string, object: Record<string, unknown>, id?: string): Promise<{ status: number; id: string }> {
  const { POST } = await import('@/app/api/billing/stripe-webhook/route');
  const eventId = id ?? `evt_l81e_${++evtN}_${uid('e')}`;
  const event = { id: eventId, object: 'event', type, created: now(), livemode: false, data: { object } };
  const res = await POST(new NextRequest('https://app.e2e.test/api/billing/stripe-webhook', {
    method: 'POST', body: JSON.stringify(event), headers: { 'stripe-signature': 't=1,v1=e2e' },
  }));
  return { status: res.status, id: eventId };
}

scenario('L81E', 'Notifications : écarts résiduels 79C (abonnement, paiement, renouvellement, récapitulatif, statuts)', ({ sql, make }) => {
  beforeEach(async () => {
    const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
    setMobilePushProviderForTests(fournisseurPush as never);
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@verebona.com', 'support@verebona.com')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    await sql`INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
              SELECT 'PREMIUM_CONFIRMATION', 'Confirmation de votre abonnement Verebona Premium',
                     'Bonjour {{firstName}}, {{planLabel}} — {{amountLabel}} — {{periodLabel}} — prochaine échéance {{nextBillingDate}}', '[]', now()
               WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'PREMIUM_CONFIRMATION')`;
    await sql`INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
              SELECT 'DOWNGRADE_NOTIFICATION', 'Votre offre Verebona a changé', 'Bonjour {{firstName}}. Revoir mon offre : {{actionUrl}}', '[]', now()
               WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'DOWNGRADE_NOTIFICATION')`;
  });

  async function compte(o: { plan?: 'STANDARD' | 'PREMIUM'; status?: string; subId?: string } = {}) {
    const acc = await make.account({ plan: null });
    const customer = `cus_${uid('l81e')}`;
    await sql`UPDATE accounts SET stripe_customer_id = ${customer}, plan_type = ${o.plan ?? 'STANDARD'},
                subscription_status = ${o.status ?? 'TRIALING'}, stripe_subscription_id = ${o.subId ?? null}
              WHERE id = ${acc.id}`;
    await sql`UPDATE users SET first_name = 'Camille' WHERE id = ${acc.ownerUserId}`;
    if (o.subId) {
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, stripe_subscription_id, stripe_customer_id, cancel_at_period_end)
                VALUES (${acc.id}, ${(o.plan ?? 'STANDARD').toLowerCase()}, 'active', ${o.subId}, ${customer}, false)`;
    }
    const [u] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${acc.ownerUserId}`;
    // Téléphone de l'application mobile (lot 97) : seul destinataire possible d'un push.
    const jeton = `l81e-${acc.ownerUserId}-${'x'.repeat(30)}`;
    const { registerPushInstallation } = await import('@/lib/mobile/push-installations');
    await registerPushInstallation({ userId: acc.ownerUserId, accountId: acc.id, sessionId: null, installationId: crypto.randomUUID(),
      platform: 'android', appVersion: '1.0.0', build: '1', pushToken: jeton });
    return { ...acc, userId: acc.ownerUserId, email: u.email, customer, endpoint: jeton };
  }
  /** Vide l'outbox, y compris les traitements immédiats encore en vol (lancés sans attente par `emit`). */
  async function traiter() {
    const { processPending } = await import('@/lib/notifications');
    for (let i = 0; i < 60; i++) {
      const s = await processPending(100);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_outbox
        WHERE status = 'processing' OR (status = 'pending' AND (scheduled_for IS NULL OR scheduled_for <= now()))`;
      if (s.claimed === 0 && n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const mailsA = (email: string) => etat.mails.filter((m) => m.to === email);
  const operations = (accountId: number) => sql<{ kind: string; email_job_id: number | null; notification_type: string | null }[]>`
    SELECT kind, email_job_id, notification_type FROM subscription_communication_operations WHERE account_id = ${accountId} ORDER BY id`;
  const lignes = (userId: number, type: string) => sql<{ id: string; status: string; payload_json: Record<string, unknown>; outcome_reason: string | null; grouped_with_id: string | null }[]>`
    SELECT id::text, status, payload_json, outcome_reason, grouped_with_id::text FROM notification_outbox
     WHERE recipient_user_id = ${userId} AND event_type = ${type} ORDER BY created_at, id`;
  const livraisons = (outboxId: string) => sql<{ channel: string; status: string; last_error_code: string | null }[]>`
    SELECT channel, status, last_error_code FROM notification_deliveries WHERE outbox_id = ${outboxId}::uuid ORDER BY channel`;
  const jobs = (userId: number, kind: string) => sql<{ id: number; status: string; attempts: number; provider_outcome: string | null; last_error: string | null }[]>`
    SELECT id, status, attempts, provider_outcome, last_error FROM transactional_email_jobs WHERE user_id = ${userId} AND kind = ${kind} ORDER BY id`;

  it('L81E-E2E-01 activation : webhooks simultanés, doublon et rejeu désordonné → une opération, une confirmation durable', async () => {
    const c = await compte();
    const subId = `sub_${uid('act')}`;
    const s = sub({ id: subId, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id });
    etat.subs.set(subId, s);
    const inv = facture({ id: `in_${uid('act')}`, customer: c.customer, subId, reason: 'subscription_create', status: 'paid' });
    const doublon = `evt_l81e_doublon_${uid('d')}`;
    const r = await Promise.all([
      webhook('customer.subscription.created', s), webhook('customer.subscription.updated', s),
      webhook('invoice.paid', inv), webhook('invoice.payment_succeeded', inv),
      webhook('customer.subscription.updated', s, doublon), webhook('customer.subscription.updated', s, doublon),
    ]);
    for (const x of r) expect([200, 409]).toContain(x.status);
    // Relivraison Stripe des 409, puis rejeu complet dans l'ordre inverse.
    await webhook('customer.subscription.updated', s, doublon);
    for (const [t, o] of [['invoice.payment_succeeded', inv], ['invoice.paid', inv], ['customer.subscription.updated', s], ['customer.subscription.created', s]] as const) {
      expect((await webhook(t, o as Record<string, unknown>)).status).toBe(200);
    }
    await traiter();

    const ops = await operations(c.id);
    expect(ops.map((o) => o.kind)).toEqual(['ACTIVATION']);
    const [job] = await jobs(c.userId, 'PREMIUM_CONFIRMATION');
    expect(job).toMatchObject({ id: ops[0].email_job_id, status: 'accepted' });
    const notifs = await lignes(c.userId, 'SUBSCRIPTION_ACTIVATED');
    expect(notifs).toHaveLength(1);
    expect(notifs[0].payload_json).toMatchObject({ planCode: 'PREMIUM', confirmationJobId: job.id });
    expect(notifs[0].status).toBe('sent');
    // E-mail générique couvert par la confirmation DURABLE de la même opération (cause tracée).
    expect((await livraisons(notifs[0].id)).find((l) => l.channel === 'email')).toEqual({
      channel: 'email', status: 'skipped_unavailable', last_error_code: `covered_by_contract_confirmation:${job.id}`,
    });
    const recus = mailsA(c.email);
    expect(recus.map((m) => m.subject)).toEqual(['Confirmation de votre abonnement Verebona Premium']);
    // Données contractuelles exactes de l'opération, figées dans la demande.
    const [ctx] = await sql<{ context: Record<string, unknown> }[]>`SELECT context FROM transactional_email_jobs WHERE id = ${job.id}`;
    expect(ctx.context).toMatchObject({ planLabel: 'Premium', unitAmountCents: 590, billingPeriod: 'monthly' });
  });

  it('L81E-E2E-02 confirmation : refus du prestataire, reprise, réponse incertaine sans doublon, échec final supervisé', async () => {
    const { processEmailJob } = await import('@/services/email/transactional-email-jobs.service');
    const c = await compte();
    const subId = `sub_${uid('conf')}`;
    etat.subs.set(subId, sub({ id: subId, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id, period: 'yearly' }));
    etat.modes.set(c.email, 'reject');
    expect((await webhook('customer.subscription.created', etat.subs.get(subId)!)).status).toBe(200);
    await traiter();
    let [job] = await jobs(c.userId, 'PREMIUM_CONFIRMATION');
    // Refus confirmé : demande conservée, en reprise — jamais « envoyée ».
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(mailsA(c.email)).toHaveLength(0);
    // La notification ne remplace pas la confirmation obligatoire par un e-mail générique.
    const [notif] = await lignes(c.userId, 'SUBSCRIPTION_ACTIVATED');
    expect((await livraisons(notif.id)).find((l) => l.channel === 'email')?.last_error_code).toBe(`covered_by_contract_confirmation:${job.id}`);

    // Reprise : réponse perdue (acceptée chez le prestataire, 500 rendu).
    etat.modes.set(c.email, 'uncertain');
    const t = (h: number) => new Date(Date.now() + h * 3_600_000);
    expect((await processEmailJob(job.id, t(1))).status).toBe('pending');
    [job] = await jobs(c.userId, 'PREMIUM_CONFIRMATION');
    expect(job.provider_outcome).toBe('uncertain');
    // Nouvelle tentative : même clé d'idempotence — réponse d'origine, aucun second e-mail.
    expect((await processEmailJob(job.id, t(3))).status).toBe('accepted');
    expect(mailsA(c.email)).toHaveLength(1);
    expect(await sql`SELECT 1 FROM admin_anomalies WHERE fingerprint = ${`communications:transactional:premium_confirmation:${job.id}`} AND status = 'open'`).toHaveLength(0);

    // Échec définitif : visible et supervisé au BO (anomalie), jamais silencieux.
    const c2 = await compte();
    const sub2 = `sub_${uid('conf2')}`;
    etat.subs.set(sub2, sub({ id: sub2, customer: c2.customer, status: 'active', plan: 'premium', accountId: c2.id }));
    etat.modes.set(c2.email, 'reject');
    await webhook('customer.subscription.created', etat.subs.get(sub2)!);
    let [j2] = await jobs(c2.userId, 'PREMIUM_CONFIRMATION');
    for (let h = 1; j2.status === 'pending' && h < 40; h += 5) {
      await processEmailJob(j2.id, t(h));
      [j2] = await jobs(c2.userId, 'PREMIUM_CONFIRMATION');
    }
    expect(j2.status).toBe('failed');
    expect(await sql`SELECT 1 FROM admin_anomalies WHERE fingerprint = ${`communications:transactional:premium_confirmation:${j2.id}`} AND status = 'open'`).toHaveLength(1);
    const { searchTransactionalEmails } = await import('@/services/admin/transactional-email-logs.service');
    const bo = await searchTransactionalEmails({ type: 'PREMIUM_CONFIRMATION', recipient: c2.email } as never);
    expect(bo.closedRequests.map((x) => [x.jobId, x.status])).toContainEqual([j2.id, 'failed']);
    etat.modes.delete(c2.email);
  });

  it('L81E-E2E-03 résiliation programmée ≠ prise d’effet ; deux opérations en moins de 24 h ; producteurs multiples ; webhook tardif', async () => {
    const subA = `sub_${uid('a')}`;
    const c = await compte({ plan: 'PREMIUM', status: 'ACTIVE', subId: subA });
    etat.subs.set(subA, sub({ id: subA, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id,
      cancelAtPeriodEnd: true, cancelAt: now() + 30 * 86400, canceledAt: now() - 60 }));
    // Résiliation programmée : rejouée deux fois → une seule communication.
    await webhook('customer.subscription.updated', etat.subs.get(subA)!);
    await webhook('customer.subscription.updated', etat.subs.get(subA)!);
    await traiter();
    expect((await operations(c.id)).map((o) => o.kind)).toEqual(['CANCELLATION_SCHEDULED']);
    const prog = await lignes(c.userId, 'SUBSCRIPTION_CANCELLATION_SCHEDULED');
    expect(prog).toHaveLength(1);
    expect(prog[0].payload_json.effectiveAt).toBeTruthy();

    // Prise d'effet : synchronisation `canceled` ET webhook `deleted`, simultanés → une opération.
    etat.subs.set(subA, sub({ id: subA, customer: c.customer, status: 'canceled', plan: 'premium', accountId: c.id, endedAt: now() }));
    await Promise.all([
      webhook('customer.subscription.updated', etat.subs.get(subA)!),
      webhook('customer.subscription.deleted', etat.subs.get(subA)!),
    ]);
    await traiter();
    expect((await operations(c.id)).map((o) => o.kind)).toEqual(['CANCELLATION_SCHEDULED', 'CANCELLATION_EFFECTIVE']);
    expect(mailsA(c.email).filter((m) => m.subject === 'Votre offre Verebona a changé')).toHaveLength(1);
    const fin1 = await lignes(c.userId, 'SUBSCRIPTION_CANCELLED');
    expect(fin1).toHaveLength(1);
    expect(fin1[0].payload_json.endedEmailJobId).toEqual(expect.any(Number));

    // Nouvel abonnement B, puis sa fin LE MÊME JOUR : opération distincte, communiquée.
    const subB = `sub_${uid('b')}`;
    etat.subs.set(subB, sub({ id: subB, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id }));
    await webhook('customer.subscription.created', etat.subs.get(subB)!);
    etat.subs.set(subB, sub({ id: subB, customer: c.customer, status: 'canceled', plan: 'premium', accountId: c.id, endedAt: now() }));
    await webhook('customer.subscription.deleted', etat.subs.get(subB)!);
    await traiter();
    expect((await operations(c.id)).map((o) => o.kind)).toEqual(['CANCELLATION_SCHEDULED', 'CANCELLATION_EFFECTIVE', 'ACTIVATION', 'CANCELLATION_EFFECTIVE']);
    expect(mailsA(c.email).filter((m) => m.subject === 'Votre offre Verebona a changé')).toHaveLength(2);
    expect(await lignes(c.userId, 'SUBSCRIPTION_CANCELLED')).toHaveLength(2);

    // Webhook tardif de l'ancien abonnement A pendant un abonnement C en cours : rien.
    const subC = `sub_${uid('c')}`;
    etat.subs.set(subC, sub({ id: subC, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id }));
    await webhook('customer.subscription.created', etat.subs.get(subC)!);
    await webhook('customer.subscription.deleted', etat.subs.get(subA)!);
    const [apres] = await sql<{ plan_type: string; stripe_subscription_id: string }[]>`SELECT plan_type, stripe_subscription_id FROM accounts WHERE id = ${c.id}`;
    expect(apres).toEqual({ plan_type: 'PREMIUM', stripe_subscription_id: subC });
    expect((await operations(c.id)).filter((o) => o.kind === 'CANCELLATION_EFFECTIVE')).toHaveLength(2);
  });

  it('L81E-E2E-04 incidents de paiement : ordre, retard, doublon, concurrence, factures distinctes, facture réglée, porteur en échec, rappels', async () => {
    const subP = `sub_${uid('p')}`;
    const c = await compte({ plan: 'PREMIUM', status: 'ACTIVE', subId: subP });
    etat.subs.set(subP, sub({ id: subP, customer: c.customer, status: 'past_due', plan: 'premium', accountId: c.id }));
    const echu = async (invoiceId: string) => sql`UPDATE notification_outbox SET scheduled_for = now() - interval '1 second'
                                                   WHERE recipient_user_id = ${c.userId} AND entity_id = ${invoiceId} AND status = 'pending'`;
    const parFacture = async (invoiceId: string) => (await sql<{ event_type: string; status: string; auth: boolean | null; grouped_with_id: string | null; id: string; outcome_reason: string | null }[]>`
      SELECT event_type, status, (payload_json->>'authenticationRequired')::boolean AS auth, grouped_with_id::text, id::text, outcome_reason
        FROM notification_outbox WHERE recipient_user_id = ${c.userId} AND entity_id = ${invoiceId} ORDER BY event_type`);

    // (a) Ordre habituel : authentification puis échec — un message, avec l'action.
    const i1 = `in_${uid('i1')}`;
    await webhook('invoice.payment_action_required', facture({ id: i1, customer: c.customer, subId: subP }));
    await webhook('invoice.payment_failed', facture({ id: i1, customer: c.customer, subId: subP }));
    await webhook('invoice.payment_failed', facture({ id: i1, customer: c.customer, subId: subP })); // (c) doublon
    await echu(i1); await traiter();
    let r1 = await parFacture(i1);
    expect(r1.map((x) => [x.event_type, x.status, x.auth])).toEqual([['PAYMENT_ACTION_REQUIRED', 'grouped', null], ['PAYMENT_FAILED', 'sent', true]]);
    expect(r1[0].grouped_with_id).toBe(r1[1].id);
    const mails1 = mailsA(c.email).length;
    expect(mails1).toBe(1);

    // (b) Webhook d'échec TARDIF : l'authentification déjà partie seule ; l'échec
    // (évolution : suspension) part ensuite et rappelle l'action.
    const i2 = `in_${uid('i2')}`;
    await webhook('invoice.payment_action_required', facture({ id: i2, customer: c.customer, subId: subP }));
    await echu(i2); await traiter();
    await webhook('invoice.payment_failed', facture({ id: i2, customer: c.customer, subId: subP }));
    await traiter();
    r1 = await parFacture(i2);
    expect(r1.map((x) => [x.event_type, x.status, x.auth])).toEqual([['PAYMENT_ACTION_REQUIRED', 'sent', null], ['PAYMENT_FAILED', 'sent', true]]);
    expect(mailsA(c.email).length).toBe(mails1 + 2);

    // (d) Facture réglée avant l'envoi de l'authentification : sans objet, cause tracée.
    const i3 = `in_${uid('i3')}`;
    await webhook('invoice.payment_action_required', facture({ id: i3, customer: c.customer, subId: subP }));
    await webhook('invoice.updated', facture({ id: i3, customer: c.customer, subId: subP, status: 'paid' }));
    await echu(i3); await traiter();
    const r3 = await parFacture(i3);
    expect(r3.map((x) => [x.event_type, x.status, x.outcome_reason])).toEqual([['PAYMENT_ACTION_REQUIRED', 'skipped', 'incident_resolved:invoice_paid']]);

    // (e) Traitements SIMULTANÉS de l'échec et de l'authentification (même facture) :
    // jamais d'authentification absorbée par un échec qui ne la porte pas.
    const i4 = `in_${uid('i4')}`;
    const { emit, processOutboxIds } = await import('@/lib/notifications');
    const passe = new Date(Date.now() - 1000);
    await emit({ type: 'PAYMENT_FAILED', accountId: c.id, entityType: 'invoice', entityId: i4, payload: { accountId: c.id }, dedupeKey: `l81e:pf:${i4}`, scheduledFor: passe });
    await emit({ type: 'PAYMENT_ACTION_REQUIRED', accountId: c.id, entityType: 'invoice', entityId: i4, payload: { accountId: c.id }, dedupeKey: `l81e:par:${i4}`, scheduledFor: passe });
    const ids4 = (await parFacture(i4)).map((x) => x.id);
    await Promise.all(ids4.map((id) => processOutboxIds([id])));
    const r4 = await parFacture(i4);
    const pf4 = r4.find((x) => x.event_type === 'PAYMENT_FAILED')!;
    const par4 = r4.find((x) => x.event_type === 'PAYMENT_ACTION_REQUIRED')!;
    expect(pf4.status).toBe('sent');
    if (par4.status === 'grouped') expect(pf4.auth).toBe(true);
    else expect(par4.status).toBe('sent');
    expect(pf4.auth === true || par4.status === 'sent').toBe(true); // l'action est toujours communiquée

    // (f) Porteur finalement non envoyé : l'événement regroupé est remis en file et envoyé.
    const i5 = `in_${uid('i5')}`;
    await emit({ type: 'PAYMENT_FAILED', accountId: c.id, entityType: 'invoice', entityId: i5, payload: { accountId: c.id }, dedupeKey: `l81e:pf:${i5}`, scheduledFor: new Date(Date.now() + 3_600_000) });
    await emit({ type: 'PAYMENT_ACTION_REQUIRED', accountId: c.id, entityType: 'invoice', entityId: i5, payload: { accountId: c.id }, dedupeKey: `l81e:par:${i5}`, scheduledFor: passe });
    await traiter();
    let r5 = await parFacture(i5);
    const pf5 = r5.find((x) => x.event_type === 'PAYMENT_FAILED')!;
    expect(r5.find((x) => x.event_type === 'PAYMENT_ACTION_REQUIRED')).toMatchObject({ status: 'grouped', grouped_with_id: pf5.id });
    await sql`UPDATE notification_outbox SET status = 'failed', processed_at = now() WHERE id = ${pf5.id}::uuid`;
    const { reopenGroupedBy } = await import('@/lib/notifications/outbox');
    expect(await reopenGroupedBy(pf5.id)).toHaveLength(1);
    await traiter();
    r5 = await parFacture(i5);
    expect(r5.find((x) => x.event_type === 'PAYMENT_ACTION_REQUIRED')?.status).toBe('sent');

    // (g) Rappels légitimes du cycle d'impayé : jamais regroupés.
    const [cyc] = await sql<{ unpaid_started_at: Date }[]>`SELECT unpaid_started_at FROM accounts WHERE id = ${c.id}`;
    const { runUnpaidCycleSweep } = await import('@/services/billing/unpaid-cycle.service');
    await runUnpaidCycleSweep({ now: new Date(new Date(cyc.unpaid_started_at).getTime() + 83 * 86_400_000) }, { stripe: () => fakeStripe as never });
    await traiter();
    const rappels = await lignes(c.userId, 'ACCOUNT_READ_ONLY');
    expect(rappels.map((x) => x.status)).toEqual(['sent']);
    // SUBSCRIPTION_SUSPENDED : aucun producteur (catalogue seul) — rien n'est émis.
    expect(await lignes(c.userId, 'SUBSCRIPTION_SUSPENDED')).toHaveLength(0);
  });

  it('L81E-E2E-05 renouvellement : `receipt_number` ne supprime plus l’e-mail ; une communication par facture ; aucun push', async () => {
    const subR = `sub_${uid('r')}`;
    const c = await compte({ plan: 'PREMIUM', status: 'ACTIVE', subId: subR });
    etat.subs.set(subR, sub({ id: subR, customer: c.customer, status: 'active', plan: 'premium', accountId: c.id, period: 'yearly' }));
    const inv = facture({ id: `in_${uid('ren')}`, customer: c.customer, subId: subR, reason: 'subscription_cycle', status: 'paid', receipt: '2471-0001' });
    await webhook('invoice.paid', inv);
    await webhook('invoice.payment_succeeded', inv);
    await traiter();
    const ren = await lignes(c.userId, 'SUBSCRIPTION_RENEWED');
    expect(ren).toHaveLength(1);
    expect(ren[0].payload_json).toMatchObject({ planCode: 'PREMIUM', billingPeriod: 'yearly', nextRenewalAt: expect.any(String) });
    expect(ren[0].payload_json).not.toHaveProperty('receiptCovered');
    expect(mailsA(c.email).map((m) => m.subject)).toEqual(['Votre abonnement Verebona']);
    expect(etat.pushes.filter((p) => p.endpoint === c.endpoint)).toHaveLength(0);
    const [cloche] = await sql<{ body: string }[]>`SELECT body FROM notifications WHERE user_id = ${c.userId} AND type = 'SUBSCRIPTION_RENEWED'`;
    expect(cloche.body).toMatch(/Prochaine échéance : .* Votre facture est disponible dans Mon compte › Offres\./);
  });

  it('L81E-E2E-06 récapitulatif : préparé ≠ envoyé, reprise, inchangé, priorité, concurrence, plus de 1 000 comptes', async () => {
    const { runToProcessDigest } = await import('@/lib/notifications/scheduled/to-process-digest');
    const c = await compte();
    // Lot 82A (C-Q10) : récapitulatif de CONTENU — compte éligible (abonnement en service).
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${c.id}, 'standard', 'active')`;
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
              VALUES (${c.userId}, 'to_process', 'daily_digest', 'email', true)`;
    const action = async (q: string) => {
      const bien = await make.asset(c);
      return (await sql<{ public_id: string }[]>`
        INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
        VALUES (${c.id}, 'ASSET', ${bien.id}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', ${q}) RETURNING public_id`)[0].public_id;
    };
    const a1 = await action('A ?');
    await action('B ?');
    const recap = () => sql<{ status: string }[]>`SELECT status FROM notification_outbox WHERE recipient_user_id = ${c.userId} AND event_type = 'TO_PROCESS_DAILY_DIGEST' ORDER BY created_at, id`;
    const st = async () => (await sql<{ item_keys: string[]; last_outcome: string | null; prepared_outbox_id: string | null }[]>`
      SELECT item_keys, last_outcome, prepared_outbox_id::text FROM to_process_digest_state WHERE user_id = ${c.userId}`)[0];
    const jour = (d: number, h = 7) => new Date(Date.UTC(2027, 2, d, h, 30));

    // Échec de l'envoi (seul canal : e-mail) : contenu NON communiqué.
    etat.modes.set(c.email, 'reject');
    await runToProcessDigest(jour(2));
    expect((await recap()).map((r) => r.status)).toEqual(['failed']);
    expect(await st()).toMatchObject({ item_keys: [], last_outcome: 'failed', prepared_outbox_id: null });
    // Passage suivant du même jour : repris, envoyé, alors seulement communiqué.
    etat.modes.delete(c.email);
    await runToProcessDigest(jour(2, 8));
    expect((await recap()).map((r) => r.status)).toEqual(['failed', 'sent']);
    expect((await st()).item_keys).toHaveLength(2);
    expect((await st()).last_outcome).toBe('sent');
    // Contenu inchangé : jamais réexpédié.
    await runToProcessDigest(jour(3));
    expect(await recap()).toHaveLength(2);
    // Évolution significative d'une action existante (priorité) : nouveau récapitulatif.
    await sql`UPDATE to_process_actions SET priority = 'DO_FIRST' WHERE public_id = ${a1}::uuid`;
    await runToProcessDigest(jour(4));
    expect(await recap()).toHaveLength(3);
    // Exécutions concurrentes : un seul récapitulatif.
    await action('C ?');
    await Promise.all([runToProcessDigest(jour(5)), runToProcessDigest(jour(5)), runToProcessDigest(jour(5, 9))]);
    expect(await recap()).toHaveLength(4);
    expect(mailsA(c.email)).toHaveLength(3);

    // Plus de 1 000 comptes : pagination stable et reprise (aucun plafond de couverture).
    const tag = uid('masse');
    await sql`
      WITH u AS (
        INSERT INTO users (email, password_hash, status)
        SELECT ${tag} || '-' || g || '@test.invalid', 'e2e', 'ACTIVE' FROM generate_series(1, 1001) g RETURNING id
      ), a AS (
        INSERT INTO accounts (name, owner_user_id) SELECT ${tag}, id FROM u RETURNING id, owner_user_id
      ), m AS (
        INSERT INTO account_memberships (account_id, user_id, role, status) SELECT id, owner_user_id, 'owner', 'active' FROM a RETURNING account_id
      ), s AS (
        -- Lot 82A (C-Q10) : comptes en service (éligibles au récapitulatif de contenu).
        INSERT INTO account_subscriptions (account_id, plan_code, status) SELECT id, 'standard', 'active' FROM a RETURNING account_id
      ), b AS (
        INSERT INTO assets (user_id, account_id, category, name) SELECT owner_user_id, id, 'VEHICULE', ${tag} FROM a RETURNING id, account_id
      )
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
      SELECT account_id, 'ASSET', id, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix ?' FROM b`;
    const [dernier] = await sql<{ id: number; owner_user_id: number }[]>`SELECT id, owner_user_id FROM accounts WHERE name = ${tag} ORDER BY id DESC LIMIT 1`;
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
              VALUES (${dernier.owner_user_id}, 'to_process', 'daily_digest', 'email', true)`;
    const premier = await runToProcessDigest(jour(10), { pageSize: 200, deadline: Date.now() - 1 });
    expect(premier).toMatchObject({ capped: true, completed: false });
    const second = await runToProcessDigest(jour(10), { pageSize: 200 });
    expect(second.completed).toBe(true);
    const [run] = await sql<{ accounts_scanned: number; completed_at: Date | null }[]>`SELECT accounts_scanned, completed_at FROM to_process_digest_runs WHERE local_date = '2027-03-10'`;
    expect(run.completed_at).not.toBeNull();
    expect(run.accounts_scanned).toBeGreaterThan(1001);
    expect(await sql`SELECT 1 FROM notification_outbox WHERE recipient_user_id = ${dernier.owner_user_id} AND event_type = 'TO_PROCESS_DAILY_DIGEST' AND status = 'sent'`).toHaveLength(1);
    // Base partagée : les 1 001 comptes de masse ne ralentissent pas les autres scénarios.
    await sql`UPDATE to_process_actions SET resolved_at = now() WHERE account_id IN (SELECT id FROM accounts WHERE name = ${tag})`;
  });

  it('L81E-E2E-07 statuts outbox / BO fidèles ; migrations 0638 et 0640 sur données historiques', async () => {
    const c = await compte();
    // Lot 82A (C-Q10) : notification de CONTENU — compte éligible (abonnement en service).
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${c.id}, 'standard', 'active')`;
    const { emit } = await import('@/lib/notifications');
    const passe = new Date(Date.now() - 1000);
    // Aucun canal réellement envoyé (canaux supprimés, malgré d'anciennes préférences
    // actives) → « ignoré », jamais « envoyé », aucune anomalie.
    for (const ch of ['email', 'push']) {
      await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
                VALUES (${c.userId}, 'to_process', 'immediate', ${ch}, true)`;
    }
    await emit({ type: 'TO_PROCESS_ITEM_CREATED', recipientUserIds: [c.userId], accountId: c.id, payload: { itemKey: 'x', actionKind: 'ARBITRATE' }, dedupeKey: `l81e:tp:${c.id}`, scheduledFor: passe });
    // Envoi partiel : cloche envoyée, e-mail refusé.
    etat.modes.set(c.email, 'reject');
    await emit({ type: 'PAYMENT_FAILED', accountId: c.id, entityType: 'invoice', entityId: `in_${uid('part')}`, payload: { accountId: c.id }, dedupeKey: `l81e:part:${c.id}`, scheduledFor: passe });
    await traiter();
    etat.modes.delete(c.email);
    const [tp] = await lignes(c.userId, 'TO_PROCESS_ITEM_CREATED');
    expect(tp).toMatchObject({ status: 'skipped', outcome_reason: 'channel_retired' });
    expect(await sql`SELECT 1 FROM admin_anomalies WHERE fingerprint LIKE 'communications:notification:to_process_item_created:%' AND status = 'open'`).toHaveLength(0);
    const [pf] = await lignes(c.userId, 'PAYMENT_FAILED');
    expect(pf.status).toBe('partial');
    const { rechercherNotifications, getNotificationHealth } = await import('@/services/notifications/notification-health.service');
    const vues = await rechercherNotifications({ userId: c.userId });
    expect(vues.find((v) => v.eventType === 'TO_PROCESS_ITEM_CREATED')).toMatchObject({ status: 'skipped', outcomeReason: 'channel_retired' });
    const sante = await getNotificationHealth(1);
    expect(sante.evenementsParStatut.ignores).toBeGreaterThanOrEqual(1);
    expect(sante.evenementsParStatut.partiels).toBeGreaterThanOrEqual(1);
    // Un canal ignoré n'est ni un envoi ni un échec (les échecs réémis depuis le BO sont hors santé).
    for (const canal of sante.livraisonsParCanal) expect(canal.envoyees + canal.echouees + canal.ignorees).toBeLessThanOrEqual(canal.total);
    const [moi] = await sql<{ envoyes: number; ignores: number }[]>`
      SELECT count(*) FILTER (WHERE d.status = 'sent')::int AS envoyes, count(*) FILTER (WHERE d.status LIKE 'skipped%')::int AS ignores
        FROM notification_deliveries d WHERE d.outbox_id = ${tp.id}::uuid`;
    expect(moi).toEqual({ envoyes: 0, ignores: 2 });

    // Historique : seuls les statuts reconstructibles sont corrigés (0638, rejouable).
    const ins = async (status: string, lastError: string | null) => (await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, payload_json, priority, dedupe_key, status, last_error, created_at)
      VALUES ('DOCUMENT_UPLOAD_COMPLETED', 'documents', ${c.id}, ${c.userId}, '{"count":1}'::jsonb, 'low', ${`l81e:hist:${uid('h')}`}, ${status}, ${lastError}, now() - interval '30 days')
      RETURNING id::text`)[0].id;
    const porteur = await ins('sent', null);
    await sql`INSERT INTO notification_deliveries (outbox_id, user_id, channel, status, attempt_count) VALUES (${porteur}::uuid, ${c.userId}, 'bell', 'sent', 1)`;
    const regroupe = await ins('cancelled', `grouped_with:${porteur}`);
    const ignore = await ins('sent', null);
    await sql`INSERT INTO notification_deliveries (outbox_id, user_id, channel, status, last_error_code, attempt_count)
              VALUES (${ignore}::uuid, ${c.userId}, 'email', 'skipped_unavailable', 'channel_retired', 1),
                     (${ignore}::uuid, ${c.userId}, 'push', 'skipped_unavailable', 'channel_retired', 1)`;
    const inconnu = await ins('sent', null);
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0638_l81e_statuts_outbox_lots.sql'), 'utf8');
    await runMigrationSql(sql as unknown as SqlRunner, migration);
    await runMigrationSql(sql as unknown as SqlRunner, migration);
    const statut = async (id: string) => (await sql<{ status: string; outcome_reason: string | null; grouped_with_id: string | null }[]>`
      SELECT status, outcome_reason, grouped_with_id::text FROM notification_outbox WHERE id = ${id}::uuid`)[0];
    expect(await statut(porteur)).toEqual({ status: 'sent', outcome_reason: null, grouped_with_id: null });
    expect(await statut(regroupe)).toEqual({ status: 'grouped', outcome_reason: 'grouped_incident', grouped_with_id: porteur });
    expect(await statut(ignore)).toEqual({ status: 'skipped', outcome_reason: 'channel_retired', grouped_with_id: null });
    expect(await statut(inconnu)).toEqual({ status: 'sent', outcome_reason: null, grouped_with_id: null }); // non reconstructible

    // 0640 : un contenu enregistré à la mise en file mais jamais accepté redevient « à communiquer ».
    const echec = await ins('failed', null);
    await sql`UPDATE notification_outbox SET event_type = 'TO_PROCESS_DAILY_DIGEST', category = 'to_process' WHERE id = ${echec}::uuid`;
    await sql`INSERT INTO to_process_digest_state (account_id, user_id, item_keys, total) VALUES (${c.id}, ${c.userId}, '{"x:c1"}', 1)
              ON CONFLICT (account_id, user_id) DO UPDATE SET item_keys = '{"x:c1"}', sent_fingerprints = NULL`;
    const m640 = readFileSync(join(process.cwd(), 'src/db/migrations/0640_l81e_recapitulatif_envoye.sql'), 'utf8');
    await runMigrationSql(sql as unknown as SqlRunner, m640);
    await runMigrationSql(sql as unknown as SqlRunner, m640);
    const [d] = await sql<{ item_keys: string[]; last_outcome: string }[]>`SELECT item_keys, last_outcome FROM to_process_digest_state WHERE user_id = ${c.userId}`;
    expect(d).toEqual({ item_keys: [], last_outcome: 'failed' });
  });
});

scenario('L81E-LOTS', 'Résultat des lots d’analyse établi depuis les états réels (pipeline T1 et file durable)', ({ sql, make, useRecordings: enregistrer }) => {
  useTargetState();

  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
  });

  const fichier = async (compteId: Parameters<typeof make.assetFile>[0], titre: string) => {
    const f = await make.assetFile(compteId);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`${titre}.pdf`}, retained_title = ${titre},
                upload_status = 'COMPLETED', analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const succes = (title: string) => ({
    operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT',
    output: sortieT1({ title, date: '2026-03-14', documentTypeCode: 'MAINTENANCE_INVOICE', assets: [], facts: [] }),
  });
  const resultats = (userId: number) => sql<{ event_type: string; status: string; payload_json: Record<string, unknown> }[]>`
    SELECT event_type, status, payload_json FROM notification_outbox
     WHERE recipient_user_id = ${userId} AND event_type IN ('DOCUMENT_BATCH_COMPLETED', 'DOCUMENT_BATCH_PARTIALLY_FAILED', 'DOCUMENT_BATCH_FAILED', 'ANALYSIS_FAILED_PERSISTENT')
     ORDER BY created_at, id`;
  const jobDe = async (id: number) => (await sql<{ id: number; status: string }[]>`
    SELECT id, status FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(id)} ORDER BY id DESC LIMIT 1`)[0];
  const lotsDe = (fileId: number) => sql<{ id: number; notification_state: string; notification_outcome: string | null; notification_absorbed_into: number | null }[]>`
    SELECT l.id, l.notification_state, l.notification_outcome, l.notification_absorbed_into FROM document_lots l
      JOIN document_lot_items i ON i.lot_id = l.id WHERE i.asset_file_id = ${fileId} ORDER BY l.id`;
  async function traiter() {
    const { processPending } = await import('@/lib/notifications');
    for (let i = 0; i < 60; i++) {
      const s = await processPending(100);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_outbox
        WHERE status = 'processing' OR (status = 'pending' AND (scheduled_for IS NULL OR scheduled_for <= now()))`;
      if (s.claimed === 0 && n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  async function dernierEssaiEnEchec(fileId: number) {
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    const { MAX_ATTEMPTS } = await import('@/services/ai/queue/queue-policy');
    const job = await jobDe(fileId);
    await sql`UPDATE ai_job_queue SET attempts = ${MAX_ATTEMPTS - 1}, available_at = now() WHERE id = ${job.id}`;
    await enregistrer([]);
    expect(await runOne('T1')).toBe(true);
    expect((await jobDe(fileId)).status).toBe('FAILED');
  }

  it('L81E-E2E-08a lot partiellement échoué : rien d’annoncé tant que la reprise est prévue, puis UNE réussite partielle nommant le document', async () => {
    await ecarterLesAutresJobsT1();
    const c = await make.account();
    const ok = await fichier(c, 'Facture garage');
    const ko = await fichier(c, 'Devis carrosserie');
    const { registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    registerSourceAnalysisHandler();
    await enregistrer([succes('Facture garage')]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([ok.id, ko.id], c.id, { userId: c.ownerUserId, origin: 'documents/analyze-batch' });
    expect(r).toMatchObject({ analysedCount: 1, failedSourceIds: [ko.id] });
    // Reprise automatique prévue (file durable) : ni réussite annoncée à tort, ni échec définitif.
    await traiter();
    expect(await resultats(c.ownerUserId)).toEqual([]);
    expect((await lotsDe(ko.id))[0].notification_state).toBe('awaiting');

    await dernierEssaiEnEchec(ko.id);
    await traiter();
    const res = await resultats(c.ownerUserId);
    expect(res.map((x) => [x.event_type, x.status])).toEqual([['DOCUMENT_BATCH_PARTIALLY_FAILED', 'sent']]);
    expect(res[0].payload_json).toMatchObject({ analysedCount: 1, failedCount: 1, documents: [{ assetFileId: ko.id, title: 'Devis carrosserie' }], assetFileId: ko.id });
    const lots = await lotsDe(ko.id);
    expect(lots[0]).toMatchObject({ notification_state: 'notified', notification_outcome: 'PARTIALLY_FAILED' });
    expect(lots.slice(1).every((l) => l.notification_state === 'absorbed' && l.notification_absorbed_into === lots[0].id)).toBe(true);
    const [cloche] = await sql<{ body: string }[]>`SELECT body FROM notifications WHERE user_id = ${c.ownerUserId} AND type = 'DOCUMENT_BATCH_PARTIALLY_FAILED'`;
    expect(cloche.body).toBe('1 document analysé, 1 n’a pas pu l’être : “Devis carrosserie”. Vous pouvez relancer l’analyse depuis la fiche du document, dans Documents.');
    // Aucun e-mail d'analyse (décision 79C).
    expect(await sql`SELECT 1 FROM notification_deliveries d JOIN notification_outbox o ON o.id = d.outbox_id
                      WHERE o.recipient_user_id = ${c.ownerUserId} AND d.channel = 'email' AND d.status = 'sent'`).toHaveLength(0);
  });

  it('L81E-E2E-08b échec total : notifié (plus jamais silencieux) ; deux analyses distinctes du même document → deux incidents', async () => {
    await ecarterLesAutresJobsT1();
    const c = await make.account();
    const f = await fichier(c, 'Contrat assurance');
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    registerSourceAnalysisHandler();
    await enqueueFileAnalyses([f.id], c.id, { origin: 'documents/analyze-batch', userId: c.ownerUserId });
    await dernierEssaiEnEchec(f.id);
    await traiter();
    let res = await resultats(c.ownerUserId);
    expect(res.map((x) => [x.event_type, x.status])).toEqual([['DOCUMENT_BATCH_FAILED', 'sent']]);
    const lotA = Number(res[0].payload_json.lotId);

    // Nouvelle analyse du même document (relance), de nouveau en échec : incident DISTINCT.
    await enqueueFileAnalyses([f.id], c.id, { origin: 'documents/analyze', userId: c.ownerUserId });
    await dernierEssaiEnEchec(f.id);
    await traiter();
    res = await resultats(c.ownerUserId);
    expect(res.map((x) => x.event_type)).toEqual(['DOCUMENT_BATCH_FAILED', 'DOCUMENT_BATCH_FAILED']);
    const lotB = Number(res[1].payload_json.lotId);
    expect(lotB).not.toBe(lotA);

    // Alerte documentaire du second incident : regroupée avec l'alerte de SON lot,
    // jamais absorbée par l'ancien incident du même document.
    const { emit } = await import('@/lib/notifications');
    await emit({ type: 'ANALYSIS_FAILED_PERSISTENT', recipientUserIds: [c.ownerUserId], accountId: c.id,
      payload: { assetFileId: f.id, lotId: lotB, documentTitle: 'Contrat assurance' }, dedupeKey: `l81e:afp:${lotB}`, scheduledFor: new Date(Date.now() - 1000) });
    await traiter();
    const [afp] = await sql<{ status: string; grouped_with_id: string }[]>`
      SELECT status, grouped_with_id::text FROM notification_outbox WHERE dedupe_key = ${`l81e:afp:${lotB}:u${c.ownerUserId}`}`;
    const [porteurB] = await sql<{ id: string }[]>`SELECT id::text FROM notification_outbox WHERE dedupe_key = ${`document:lot-result:${lotB}:u${c.ownerUserId}`}`;
    expect(afp).toEqual({ status: 'grouped', grouped_with_id: porteurB.id });
    // Identité incomplète (historique, sans lot) : jamais rapprochée arbitrairement.
    await emit({ type: 'ANALYSIS_FAILED_PERSISTENT', recipientUserIds: [c.ownerUserId], accountId: c.id,
      payload: { assetFileId: f.id }, dedupeKey: `l81e:afp:hist:${f.id}`, scheduledFor: new Date(Date.now() - 1000) });
    await traiter();
    const [hist] = await sql<{ status: string }[]>`SELECT status FROM notification_outbox WHERE dedupe_key = ${`l81e:afp:hist:${f.id}:u${c.ownerUserId}`}`;
    expect(hist.status).toBe('sent');
  });

  it('L81E-E2E-08c échec transitoire puis reprise réussie : UNE réussite annoncée (lot d’origine), aucun échec', async () => {
    await ecarterLesAutresJobsT1();
    const c = await make.account();
    const f = await fichier(c, 'Facture pneus');
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();
    await enqueueFileAnalyses([f.id], c.id, { origin: 'documents/analyze-batch', userId: c.ownerUserId });
    await enregistrer([]);
    expect(await runOne('T1')).toBe(true);
    expect((await jobDe(f.id)).status).toBe('PENDING');
    await traiter();
    expect(await resultats(c.ownerUserId)).toEqual([]);
    await enregistrer([succes('Facture pneus')]);
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${(await jobDe(f.id)).id}`;
    expect(await runOne('T1')).toBe(true);
    await traiter();
    const res = await resultats(c.ownerUserId);
    expect(res.map((x) => x.event_type)).toEqual(['DOCUMENT_BATCH_COMPLETED']);
    const lots = await lotsDe(f.id);
    expect(res[0].payload_json.lotId).toBe(lots[0].id);
    expect(res[0].payload_json).toMatchObject({ analysedCount: 1, failedCount: 0, assetFileId: f.id, documentTitle: expect.stringMatching(/^Facture pneus/) });
    expect(lots[1]).toMatchObject({ notification_state: 'absorbed', notification_absorbed_into: lots[0].id });
  });

  it('L81E-E2E-08d doublon et fichier regroupé : réussite, jamais un échec ; filet de rattrapage d’un lot resté en attente', async () => {
    const c = await make.account();
    const a = await fichier(c, 'Facture A');
    const d = await fichier(c, 'Facture A (copie)');
    const g = await fichier(c, 'Facture A page 2');
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED' WHERE id = ${a.id}`;
    await sql`UPDATE asset_files SET analysis_state = 'FUSION_SUGGESTED' WHERE id = ${d.id}`;
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED', grouped_into_file_id = ${a.id}, deleted_at = now() WHERE id = ${g.id}`;
    const [lot] = await sql<{ id: number }[]>`INSERT INTO document_lots (account_id, status, notification_state, notification_user_id, created_at)
      VALUES (${c.id}, 'committed', 'awaiting', ${c.ownerUserId}, now() - interval '1 hour') RETURNING id`;
    await sql`INSERT INTO document_lot_items (lot_id, asset_file_id, position, analysis_status) VALUES
              (${lot.id}, ${a.id}, 0, 'completed'), (${lot.id}, ${d.id}, 1, 'completed'), (${lot.id}, ${g.id}, 2, 'completed')`;
    // Lot resté en attente (processus arrêté) : repris par la tâche planifiée.
    const { runLotNotificationSweep } = await import('@/services/ai/source-analysis/lot-notification');
    const r = await runLotNotificationSweep();
    expect(r.notified).toBeGreaterThanOrEqual(1);
    await runLotNotificationSweep(); // idempotente
    await traiter();
    const res = await resultats(c.ownerUserId);
    expect(res.map((x) => x.event_type)).toEqual(['DOCUMENT_BATCH_COMPLETED']);
    expect(res[0].payload_json).toMatchObject({ analysedCount: 2, failedCount: 0, duplicateCount: 1 });
  });
});
