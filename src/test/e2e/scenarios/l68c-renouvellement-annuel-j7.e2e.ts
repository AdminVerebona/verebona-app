/**
 * Lot 68C — ticket P1 « Abonnements annuels — e-mail automatique à J−7 avant
 * renouvellement », sur PostgreSQL 16 réel (toutes les migrations, dont 0477),
 * Stripe SIMULÉ (abonnements, aperçu de facture, portail) et Resend SIMULÉ.
 *
 * Chaque scénario vit dans son propre mois (2031-2032) : le pré-filtre ne voit
 * jamais les abonnements d'un autre scénario ni d'un autre fichier, et les
 * demandes (échéance future) ne sont jamais prises par la reprise réelle.
 *
 * ANN-J7-E2E-01 Annuel à J−8 : aucun e-mail ; J−7 : un e-mail au titulaire
 *               (texte du ticket, date, montant Stripe, lien permanent), journal.
 * ANN-J7-E2E-02 Renouvelé l'année suivante : nouveau rappel à J−7.
 * ANN-J7-E2E-03 Mensuel, essai, premier paiement après essai, annuel local mais
 *               mensuel chez Stripe : aucun rappel ; appels Stripe limités.
 * ANN-J7-E2E-04 Résiliation programmée : aucun rappel ; résiliée APRÈS la
 *               préparation : envoi annulé ; reconduction réactivée : rappel.
 * ANN-J7-E2E-05 Premium Duo annuel : titulaire payeur uniquement.
 * ANN-J7-E2E-06 Abonnement modifié avant l'envoi : montant actualisé ; date
 *               changée : envoi annulé, rappel de la nouvelle échéance.
 * ANN-J7-E2E-07 Renouvellement à 0 € : « aucun prélèvement n'est prévu ».
 * ANN-J7-E2E-08 Double exécution (simultanée, puis rejouée) : aucun doublon.
 * ANN-J7-E2E-09 Panne : Stripe indisponible (reprise au passage suivant),
 *               planificateur arrêté à J−7 (rattrapage « dans 5 jours »),
 *               jamais le jour de l'échéance ; montant indisponible : jamais
 *               envoyé sans montant, reprise puis envoi ; bascule : aucune
 *               échéance antérieure à l'activation rattrapée.
 * ANN-J7-E2E-10 E-mail désactivé dans le BO : jamais compté comme envoyé.
 * ANN-J7-E2E-11 Lien permanent : session Stripe créée au clic (plusieurs jours
 *               après), déconnecté → connexion puis retour, invité Duo refusé
 *               sans fuite ; résiliation depuis le portail Stripe (webhook
 *               customer.subscription.updated) répercutée → aucun rappel.
 * ANN-J7-E2E-12 BO : envois, demandes closes avec motif, état du traitement ;
 *               tâche créée suspendue, réactivable, exécutable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { createFakePortalConfigurations } from '../../fakes/stripe-portal-configurations';

const APP = 'https://app.e2e.verebona.test';
const CAPTURES = '/tmp/claude-0/-home-claude/a4861be4-8965-51fc-aa43-814f4a37e62a/scratchpad/l68/mail-68c';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule_68';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  process.env.APP_URL = 'https://app.e2e.verebona.test';
  type Sub = Record<string, unknown> & { id: string };
  return {
    calls: [] as Array<{ to: string; subject: string; html: string; text: string }>,
    subs: new Map<string, Sub>(),
    /** Montant (centimes) de l'aperçu par abonnement ; null : aperçu inutilisable. */
    amounts: new Map<string, number | null>(),
    retrieveCalls: [] as string[],
    previewCalls: [] as Array<Record<string, unknown>>,
    sessions: [] as Array<{ customer: string; return_url: string }>,
    stripeDown: false,
    portal: { enabled: true, mode: 'at_period_end' } as { enabled: boolean; mode: string },
  };
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject: string; html: string; text: string }) => {
        etat.calls.push(p);
        return { data: { id: `em_68_${etat.calls.length}` }, error: null };
      },
    };
  },
}));

// Lot 70B : configurations du portail simulées (configuration Verebona trouvée ou créée).
const portalFake = createFakePortalConfigurations({ defaultConfiguration: { features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end' } } } });
const fakeStripe = {
  subscriptions: {
    retrieve: async (id: string) => {
      etat.retrieveCalls.push(id);
      if (etat.stripeDown) throw new Error('Stripe indisponible (simulé)');
      const s = etat.subs.get(id);
      if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing' });
      return structuredClone(s);
    },
  },
  invoices: {
    createPreview: async (p: { subscription?: string; schedule?: string }) => {
      etat.previewCalls.push(p);
      if (etat.stripeDown) throw new Error('Stripe indisponible (simulé)');
      const id = p.subscription ?? [...etat.subs.values()].find((s) => (s.schedule as { id?: string } | null)?.id === p.schedule)?.id ?? '';
      const s = etat.subs.get(id) as { items: { data: Array<{ current_period_end: number }> } } | undefined;
      const amount = etat.amounts.has(id) ? etat.amounts.get(id) : 5900;
      if (!s || amount == null) return { amount_due: null, currency: 'eur', lines: { data: [] } };
      const start = s.items.data[0].current_period_end;
      return { amount_due: amount, currency: 'eur', lines: { data: [{ period: { start, end: start + 365 * 86400 } }] } };
    },
  },
  billingPortal: {
    configurations: portalFake.configurations,
    sessions: {
      create: async (p: { customer: string; return_url: string }) => {
        etat.sessions.push(p);
        return { url: `https://billing.stripe.com/p/session/test_${etat.sessions.length}` };
      },
    },
  },
};
vi.mock('@/lib/stripe', async (orig) => ({ ...(await orig<object>()), getStripeServer: () => fakeStripe }));

const YEARLY = 'price_e2e_l68_premium_yearly';
/** Lot 72F : le libellé suit l'offre du prix Stripe (Premium Duo annuel). */
const DUO_YEARLY = 'price_e2e_l68_duo_yearly';
const MONTHLY = 'price_e2e_l68_premium_monthly';
const DAY = 86_400;
const tsOf = (d: Date) => Math.floor(d.getTime() / 1000);

function req(path: string, init: { cookie?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: APP, host: 'app.e2e.verebona.test' };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${path}`, { method: init.method ?? 'POST', headers, body: init.method === 'GET' ? undefined : '{}' });
}

scenario('ANN-J7', 'Abonnements annuels : e-mail automatique à J−7 avant renouvellement', ({ sql, make }) => {
  /** Instant de l'heure murale de Paris `hh:mm` le jour `day` (YYYY-MM-DD). */
  let paris: (day: string, hh?: number, mm?: number) => Date;

  beforeAll(async () => {
    const { parisWallTimeToDate } = await import('@/services/scheduling/task-calendar');
    paris = (day, hh = 9, mm = 0) => parisWallTimeToDate(day, [hh, mm]);
    const { getStripeCatalogContext } = await import('@/lib/stripe-client');
    const ctx = getStripeCatalogContext().catalogContext;
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { versionRowFrom } = await import('@/services/billing/price-history.service');
    for (const [id, interval, period, plan] of [[YEARLY, 'year', 'yearly', 'premium'], [MONTHLY, 'month', 'monthly', 'premium'], [DUO_YEARLY, 'year', 'yearly', 'premium_duo']] as const) {
      await pgCatalogStore.upsertPriceVersion(versionRowFrom(
        { id, livemode: false, product: 'prod_e2e_l68', lookup_key: null, unit_amount: interval === 'year' ? 5900 : 590, currency: 'eur', tax_behavior: 'unspecified', active: true, recurring: { interval, interval_count: 1 } } as unknown as Stripe.Price,
        plan, period, { catalogContext: ctx }, 'e2e',
      ));
    }
    mkdirSync(CAPTURES, { recursive: true });
  });

  beforeEach(async () => {
    etat.stripeDown = false;
    etat.portal = { enabled: true, mode: 'at_period_end' };
    etat.retrieveCalls.length = 0;
    etat.previewCalls.length = 0;
    process.env.RESEND_API_KEY = 're_e2e_simule_68';
    (await import('@/services/billing/annual-renewal-reminder.service')).resetPortalCheckCache();
    (await import('@/services/billing/customer-portal-configuration.service')).resetCustomerPortalConfigurationCache();
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@preprod.verebona.fr', 'support@verebona.fr')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
    await sql`DELETE FROM communication_channel_settings WHERE event_code = 'email:SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER'`;
    // Couverture déterministe : traitement actif depuis 2030. Lot 72F : bascule
    // DÉCLARÉE et tâche active (la suspension bloque aussi l'envoi).
    await sql`INSERT INTO annual_renewal_reminder_state (id, coverage_from, stripe_reminders_disabled_at) VALUES (1, '2030-01-01', '2029-12-31T10:00:00Z')
              ON CONFLICT (id) DO UPDATE SET coverage_from = '2030-01-01', stripe_reminders_disabled_at = '2029-12-31T10:00:00Z'`;
    await sql`UPDATE scheduled_task_state SET admin_disabled = false WHERE code = 'subscription-annual-renewal-reminders'`;
  });

  afterAll(async () => {
    await sql`UPDATE scheduled_task_state SET admin_disabled = true WHERE code = 'subscription-annual-renewal-reminders'`;
    await sql`UPDATE annual_renewal_reminder_state SET stripe_reminders_disabled_at = NULL WHERE id = 1`;
  });

  function stripeSub(o: { id: string; customer: string; end: Date; interval?: 'year' | 'month'; status?: string; cancel?: boolean; trialEnd?: number | null; schedule?: unknown; duo?: boolean }) {
    const end = tsOf(o.end);
    const interval = o.interval ?? 'year';
    return {
      id: o.id, object: 'subscription', customer: o.customer, status: o.status ?? 'active', cancel_at_period_end: o.cancel ?? false, cancel_at: null,
      trial_end: o.trialEnd ?? null, schedule: o.schedule ?? null, metadata: {}, start_date: end - 365 * DAY, created: end - 365 * DAY,
      items: { data: [{
        id: `si_${o.id}`, quantity: 1, current_period_start: end - (interval === 'year' ? 365 : 30) * DAY, current_period_end: end,
        price: { id: interval === 'year' ? (o.duo ? DUO_YEARLY : YEARLY) : MONTHLY, object: 'price', product: 'prod_e2e_l68', unit_amount: interval === 'year' ? 5900 : 590, currency: 'eur', tax_behavior: 'unspecified', active: true, lookup_key: null, livemode: false, recurring: { interval, interval_count: 1 } },
      }] },
    };
  }

  /** Titulaire d'un abonnement (données locales synchronisées + objet Stripe). */
  async function titulaire(o: { end: Date; period?: 'yearly' | 'monthly'; stripeInterval?: 'year' | 'month'; plan?: 'premium' | 'premium_duo'; cancel?: boolean; status?: string; trialEnd?: number | null; firstName?: string }) {
    const email = `titulaire-${uid('l68')}@test.invalid`;
    const owner = await make.user({ email, planType: o.plan === 'premium_duo' ? 'PREMIUM_DUO' : 'PREMIUM' });
    await sql`UPDATE users SET first_name = ${o.firstName ?? 'Claire'}, last_name = 'Titulaire' WHERE id = ${owner.id}`;
    const acc = await make.account({ owner, plan: o.plan ?? 'premium' });
    const customer = `cus_${uid('l68')}`;
    const subId = `sub_${uid('l68')}`;
    const period = o.period ?? 'yearly';
    await sql`UPDATE accounts SET plan_type = ${o.plan === 'premium_duo' ? 'PREMIUM_DUO' : 'PREMIUM'}, subscription_status = 'ACTIVE',
                     stripe_customer_id = ${customer}, stripe_subscription_id = ${subId} WHERE id = ${acc.id}`;
    await sql`UPDATE account_subscriptions SET stripe_customer_id = ${customer}, stripe_subscription_id = ${subId}, billing_period = ${period},
                     current_period_end_at = ${o.end.toISOString()}, cancel_at_period_end = ${o.cancel ?? false}, status = ${o.status ?? 'active'}
               WHERE account_id = ${acc.id}`;
    etat.subs.set(subId, stripeSub({ id: subId, customer, end: o.end, interval: o.stripeInterval ?? (period === 'yearly' ? 'year' : 'month'), cancel: o.cancel, status: o.status === 'trialing' ? 'trialing' : 'active', trialEnd: o.trialEnd, duo: o.plan === 'premium_duo' }));
    return { ...acc, email, customer, subId };
  }

  const service = () => import('@/services/billing/annual-renewal-reminder.service');
  const run = async (now: Date) => (await service()).runAnnualRenewalReminders({ now, stripe: fakeStripe as never, deadline: Date.now() + 60_000 });
  const jobsOf = (subId: string) => sql<{ id: number; status: string; user_id: number; recipient_email: string; dedupe_key: string; last_error: string | null; attempts: number; context: Record<string, unknown> }[]>`
    SELECT id, status, user_id, recipient_email, dedupe_key, last_error, attempts, context FROM transactional_email_jobs
     WHERE kind = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' AND context ->> 'subscriptionId' = ${subId} ORDER BY id`;
  const send = async (jobId: number, now: Date) => (await import('@/services/email/transactional-email-jobs.service')).processEmailJob(jobId, now);
  const mailsTo = (email: string) => etat.calls.filter((c) => c.to === email);

  it('ANN-J7-E2E-01 — J−8 : rien ; J−7 : un e-mail au titulaire (texte, date, montant Stripe, lien permanent), journalisé', async () => {
    const renewal = paris('2031-03-10', 10);
    const t = await titulaire({ end: renewal });

    await run(paris('2031-03-02', 8, 30));
    // J−8 à 8 h 30 : hors du pré-filtre local (échéance à plus de 8 jours), aucun appel Stripe.
    expect(etat.retrieveCalls).not.toContain(t.subId);
    await run(paris('2031-03-02', 18, 30));
    await run(paris('2031-03-02', 19, 30));
    expect(await jobsOf(t.subId)).toHaveLength(0);
    // Dans le pré-filtre le soir : vérifié UNE fois chez Stripe (« trop tôt »), pas à chaque passage.
    expect(etat.retrieveCalls.filter((x) => x === t.subId)).toHaveLength(1);
    const [attente] = await sql<{ outcome: string; reason: string }[]>`SELECT outcome, reason FROM annual_renewal_reminder_checks WHERE stripe_subscription_id = ${t.subId}`;
    expect(attente).toEqual({ outcome: 'WAITING', reason: 'TOO_EARLY' });

    await run(paris('2031-03-03', 8, 30));
    const [job, ...autres] = await jobsOf(t.subId);
    expect(autres).toHaveLength(0);
    expect(job).toMatchObject({ status: 'pending', user_id: t.ownerUserId, recipient_email: t.email, dedupe_key: `annual-renewal-reminder:${t.subId}:2031-03-10` });
    expect(mailsTo(t.email)).toHaveLength(0); // préparé, pas encore envoyé

    expect(await send(job.id, paris('2031-03-03', 8, 31))).toMatchObject({ status: 'accepted' });
    const [m] = mailsTo(t.email);
    expect(m.subject).toBe('Votre abonnement annuel Verebona sera renouvelé le 10 mars 2031');
    expect(m.html).toContain('Bonjour Claire,');
    expect(m.html).toContain('Votre abonnement annuel Premium sera renouvelé automatiquement le 10 mars 2031, dans 7 jours.');
    expect(m.html).toContain('Le renouvellement automatique est activé par défaut. Sans action de votre part, votre abonnement sera reconduit pour une nouvelle année.');
    expect(m.html).toContain('Montant prévu pour ce renouvellement : 59,00 €.');
    // Lot 72F : lien permanent CONTEXTUALISÉ au compte facturé.
    expect(m.html).toContain(`href="${APP}/mon-compte/abonnement/gerer/${t.id}"`);
    expect(m.html).toMatch(/class="vb-btn"[^>]*>Gérer mon abonnement sur Stripe</);
    expect(m.html).toContain('Vous pouvez également y consulter vos informations de facturation et vos moyens de paiement.');
    // Jamais d'URL de session Stripe (temporaire) dans l'e-mail.
    expect(m.html).not.toContain('billing.stripe.com');
    expect(m.html).not.toContain('{{');
    // Revalidation juste avant l'envoi : abonnement relu et aperçu de facture.
    expect(etat.previewCalls.at(-1)).toMatchObject({ customer: t.customer, subscription: t.subId });
    const [log] = await sql<{ status: string; recipient_user_id: number; email_job_id: number; delivery_status: string }[]>`
      SELECT status, recipient_user_id, email_job_id, delivery_status FROM email_logs WHERE email_job_id = ${job.id}`;
    expect(log).toMatchObject({ status: 'sent', recipient_user_id: t.ownerUserId, delivery_status: 'accepted' });
    const [check] = await sql<{ outcome: string; job_id: number }[]>`SELECT outcome, job_id FROM annual_renewal_reminder_checks WHERE candidate_key = ${job.dedupe_key}`;
    expect(check).toMatchObject({ outcome: 'ENQUEUED', job_id: job.id });

    writeFileSync(`${CAPTURES}/rappel-j7-clair.html`, m.html);
    writeFileSync(`${CAPTURES}/rappel-j7-sombre.html`, m.html.replace('@media (prefers-color-scheme: dark) {', '@media all {').replace('<meta name="color-scheme" content="light dark">', '<meta name="color-scheme" content="dark">'));
  });

  it('ANN-J7-E2E-02 — renouvelé l’année suivante : nouveau rappel à J−7', async () => {
    const t = await titulaire({ end: paris('2031-03-12', 10) });
    await run(paris('2031-03-05', 8, 30));
    const [j1] = await jobsOf(t.subId);
    await send(j1.id, paris('2031-03-05', 8, 31));
    // Renouvellement payé : webhook → nouvelle échéance un an plus tard.
    const next = paris('2032-03-12', 10);
    await sql`UPDATE account_subscriptions SET current_period_end_at = ${next.toISOString()} WHERE stripe_subscription_id = ${t.subId}`;
    etat.subs.set(t.subId, stripeSub({ id: t.subId, customer: t.customer, end: next }));
    await run(paris('2032-03-05', 8, 30));
    const jobs = await jobsOf(t.subId);
    expect(jobs.map((j) => j.dedupe_key)).toEqual([`annual-renewal-reminder:${t.subId}:2031-03-12`, `annual-renewal-reminder:${t.subId}:2032-03-12`]);
    expect(await send(jobs[1].id, paris('2032-03-05', 8, 31))).toMatchObject({ status: 'accepted' });
    expect(mailsTo(t.email).map((m) => m.subject)).toEqual([
      'Votre abonnement annuel Verebona sera renouvelé le 12 mars 2031',
      'Votre abonnement annuel Verebona sera renouvelé le 12 mars 2032',
    ]);
  });

  it('ANN-J7-E2E-03 — mensuel, essai, premier paiement après essai, mensuel chez Stripe : aucun rappel', async () => {
    const end = paris('2031-04-10', 10);
    const mensuel = await titulaire({ end, period: 'monthly' });
    const essai = await titulaire({ end, status: 'trialing', trialEnd: tsOf(end) });
    // Copie locale « annuelle » mais Stripe mensuel : Stripe fait foi.
    const divergent = await titulaire({ end, stripeInterval: 'month' });
    // Fin d'essai qui coïncide avec l'échéance, statut déjà « active » chez Stripe.
    const premier = await titulaire({ end, trialEnd: tsOf(end) });
    await run(paris('2031-04-03', 8, 30));
    for (const t of [mensuel, essai, divergent, premier]) expect(await jobsOf(t.subId)).toHaveLength(0);
    // Pré-filtre local : ni le mensuel ni l'essai ne coûtent un appel Stripe.
    expect(etat.retrieveCalls).not.toContain(mensuel.subId);
    expect(etat.retrieveCalls).not.toContain(essai.subId);
    const motifs = await sql<{ candidate_key: string; reason: string }[]>`
      SELECT candidate_key, reason FROM annual_renewal_reminder_checks WHERE stripe_subscription_id IN (${divergent.subId}, ${premier.subId})`;
    expect(Object.fromEntries(motifs.map((r) => [r.candidate_key.split(':')[1], r.reason]))).toEqual({ [divergent.subId]: 'NOT_ANNUAL', [premier.subId]: 'FIRST_PAYMENT_AFTER_TRIAL' });
  });

  it('ANN-J7-E2E-04 — résiliation programmée : aucun rappel ; résiliée après préparation : annulé ; réactivée : rappel', async () => {
    const end = paris('2031-05-10', 10);
    const resiliee = await titulaire({ end, cancel: true });
    await run(paris('2031-05-03', 8, 30));
    expect(await jobsOf(resiliee.subId)).toHaveLength(0);
    expect(etat.retrieveCalls).not.toContain(resiliee.subId);

    const t = await titulaire({ end });
    await run(paris('2031-05-03', 8, 30));
    const [job] = await jobsOf(t.subId);
    // Désactivation de la reconduction dans le portail entre la préparation et l'envoi.
    (etat.subs.get(t.subId) as unknown as { cancel_at_period_end: boolean }).cancel_at_period_end = true;
    expect(await send(job.id, paris('2031-05-03', 8, 31))).toMatchObject({ status: 'cancelled', error: 'CANCEL_AT_PERIOD_END' });
    expect(mailsTo(t.email)).toHaveLength(0);
    // Reconduction réactivée le lendemain : la demande annulée est relancée (une seule demande).
    (etat.subs.get(t.subId) as unknown as { cancel_at_period_end: boolean }).cancel_at_period_end = false;
    await run(paris('2031-05-04', 8, 30));
    const jobs = await jobsOf(t.subId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(await send(jobs[0].id, paris('2031-05-04', 8, 31))).toMatchObject({ status: 'accepted' });
    expect(mailsTo(t.email)[0].html).toContain('le 10 mai 2031, dans 6 jours.');
  });

  it('ANN-J7-E2E-05 — Premium Duo annuel : titulaire payeur uniquement, jamais l’invité', async () => {
    const t = await titulaire({ end: paris('2031-06-10', 10), plan: 'premium_duo' });
    const [{ id: duoId }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_customer_id, stripe_subscription_id, activated_at)
      VALUES (${t.ownerUserId}, 'ACTIVE', ${t.customer}, ${t.subId}, now()) RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duoId}, max_members = 2 WHERE id = ${t.id}`;
    const invite = await make.user({ planType: 'PREMIUM_DUO' });
    await make.account({ owner: invite, plan: 'standard' });
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at)
              VALUES (${duoId}, ${t.ownerUserId}, 'ACTIVE', 0, now()), (${duoId}, ${invite.id}, 'ACTIVE', 1, now())`;
    await run(paris('2031-06-03', 8, 30));
    const jobs = await jobsOf(t.subId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ user_id: t.ownerUserId, recipient_email: t.email });
    await send(jobs[0].id, paris('2031-06-03', 8, 31));
    expect(mailsTo(t.email)[0].html).toContain('Votre abonnement annuel Premium Duo sera renouvelé automatiquement');
    expect(mailsTo(invite.email)).toHaveLength(0);
  });

  it('ANN-J7-E2E-06 — modifié avant l’envoi : montant actualisé ; date changée : annulé puis rappel de la nouvelle échéance', async () => {
    const t = await titulaire({ end: paris('2031-07-10', 10) });
    await run(paris('2031-07-03', 8, 30));
    const [job] = await jobsOf(t.subId);
    etat.amounts.set(t.subId, 4720); // remise appliquée entre-temps (aperçu Stripe)
    await send(job.id, paris('2031-07-03', 8, 31));
    expect(mailsTo(t.email)[0].html).toContain('Montant prévu pour ce renouvellement : 47,20 €.');

    const u = await titulaire({ end: paris('2031-07-10', 10) });
    await run(paris('2031-07-03', 8, 30));
    const [ju] = await jobsOf(u.subId);
    // Échéance déplacée chez Stripe au 12 juillet avant l'envoi.
    const moved = paris('2031-07-12', 10);
    etat.subs.set(u.subId, stripeSub({ id: u.subId, customer: u.customer, end: moved }));
    expect(await send(ju.id, paris('2031-07-03', 8, 31))).toMatchObject({ status: 'cancelled', error: 'RENEWAL_DATE_CHANGED' });
    await sql`UPDATE account_subscriptions SET current_period_end_at = ${moved.toISOString()} WHERE stripe_subscription_id = ${u.subId}`;
    await run(paris('2031-07-05', 8, 30));
    const jobs = await jobsOf(u.subId);
    expect(jobs.map((j) => j.status)).toEqual(['cancelled', 'pending']);
    await send(jobs[1].id, paris('2031-07-05', 8, 31));
    expect(mailsTo(u.email).map((m) => m.subject)).toEqual(['Votre abonnement annuel Verebona sera renouvelé le 12 juillet 2031']);
  });

  it('ANN-J7-E2E-07 — renouvellement à 0 € : absence de prélèvement explicite', async () => {
    const t = await titulaire({ end: paris('2031-08-10', 10), firstName: 'Zoé' });
    etat.amounts.set(t.subId, 0);
    await run(paris('2031-08-03', 8, 30));
    const [job] = await jobsOf(t.subId);
    await send(job.id, paris('2031-08-03', 8, 31));
    const [m] = mailsTo(t.email);
    expect(m.html).toContain('Montant prévu pour ce renouvellement : 0,00 € (aucun prélèvement n’est prévu).');
    writeFileSync(`${CAPTURES}/rappel-j7-zero-euro-clair.html`, m.html);
  });

  it('ANN-J7-E2E-08 — double exécution (simultanée puis rejouée) : une seule demande, un seul e-mail', async () => {
    const t = await titulaire({ end: paris('2031-09-10', 10) });
    const now = paris('2031-09-03', 8, 30);
    await Promise.all([run(now), run(now), run(now)]);
    await run(paris('2031-09-03', 9, 30));
    await run(paris('2031-09-04', 8, 30)); // lendemain (rattrapage) : déjà en file
    const jobs = await jobsOf(t.subId);
    expect(jobs).toHaveLength(1);
    // Deux envois concurrents de la même demande : prise atomique, un seul e-mail.
    const r = await Promise.all([send(jobs[0].id, paris('2031-09-03', 8, 31)), send(jobs[0].id, paris('2031-09-03', 8, 31))]);
    expect(r.map((x) => x.status).sort()).toEqual(['accepted', 'busy']);
    await run(paris('2031-09-05', 8, 30));
    expect(await jobsOf(t.subId)).toHaveLength(1);
    expect(mailsTo(t.email)).toHaveLength(1);
  });

  it('ANN-J7-E2E-09 — pannes : reprise, rattrapage avant échéance jamais après, montant jamais inventé, bascule', async () => {
    // Stripe indisponible à 8 h 30 : erreur journalisée (lot 72F), repris à 9 h 30.
    const a = await titulaire({ end: paris('2031-10-10', 10) });
    etat.stripeDown = true;
    const r1 = await run(paris('2031-10-03', 8, 30));
    expect(r1.stripeErrors).toBeGreaterThanOrEqual(1);
    expect(await jobsOf(a.subId)).toHaveLength(0);
    etat.stripeDown = false;
    await run(paris('2031-10-03', 9, 30));
    expect(await jobsOf(a.subId)).toHaveLength(1);

    // Planificateur arrêté à J−7 et J−6 : rattrapage à J−5, « dans 5 jours ».
    const b = await titulaire({ end: paris('2031-10-20', 10) });
    await run(paris('2031-10-15', 8, 30));
    const [jb] = await jobsOf(b.subId);
    expect(jb.context).toMatchObject({ catchUp: true, renewalDate: '2031-10-20' });
    await send(jb.id, paris('2031-10-15', 8, 31));
    expect(mailsTo(b.email)[0].html).toContain('le 20 octobre 2031, dans 5 jours.');

    // Jour de l'échéance : jamais.
    const c = await titulaire({ end: paris('2031-10-25', 18) });
    await run(paris('2031-10-25', 8, 30));
    expect(await jobsOf(c.subId)).toHaveLength(0);
    // Demande préparée mais restée en file jusqu'au jour de l'échéance : annulée, jamais envoyée.
    const d = await titulaire({ end: paris('2031-10-28', 10) });
    await run(paris('2031-10-21', 8, 30));
    const [jd] = await jobsOf(d.subId);
    expect(await send(jd.id, paris('2031-10-28', 8, 0))).toMatchObject({ status: 'cancelled', error: 'TOO_LATE' });
    expect(mailsTo(d.email)).toHaveLength(0);

    // Montant indisponible : échec temporaire (aucun e-mail), reprise, puis envoi.
    const e = await titulaire({ end: paris('2031-10-30', 10) });
    etat.amounts.set(e.subId, null);
    await run(paris('2031-10-23', 8, 30));
    const [je] = await jobsOf(e.subId);
    expect(await send(je.id, paris('2031-10-23', 8, 31))).toMatchObject({ status: 'pending', error: 'AMOUNT_UNAVAILABLE' });
    expect(mailsTo(e.email)).toHaveLength(0);
    etat.amounts.set(e.subId, 5900);
    expect(await send(je.id, paris('2031-10-23', 8, 40))).toMatchObject({ status: 'accepted' });
    expect(mailsTo(e.email)).toHaveLength(1);
    // Épuisement des tentatives : « failed », relancé le lendemain par le traitement.
    const f = await titulaire({ end: paris('2031-10-31', 10) });
    etat.amounts.set(f.subId, null);
    await run(paris('2031-10-24', 8, 30));
    const [jf] = await jobsOf(f.subId);
    await sql`UPDATE transactional_email_jobs SET attempts = max_attempts - 1 WHERE id = ${jf.id}`;
    expect(await send(jf.id, paris('2031-10-24', 8, 31))).toMatchObject({ status: 'failed', error: 'AMOUNT_UNAVAILABLE' });
    etat.amounts.set(f.subId, 5900);
    await run(paris('2031-10-25', 8, 30));
    const [jf2] = await jobsOf(f.subId);
    expect(jf2).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await send(jf2.id, paris('2031-10-25', 8, 31))).toMatchObject({ status: 'accepted' });
    expect(mailsTo(f.email)[0].html).toContain('dans 6 jours.');

    // Bascule : couverture à partir du 2031-11-03 ; échéance du 2031-11-05 (J−7 le 29/10, Stripe encore actif) :
    // lot 72F — jamais présumée rappelée par Stripe, « couverture incertaine » signalée, sans envoi automatique.
    await sql`UPDATE annual_renewal_reminder_state SET coverage_from = '2031-11-03' WHERE id = 1`;
    const g = await titulaire({ end: paris('2031-11-05', 10) });
    const h = await titulaire({ end: paris('2031-11-10', 10) });
    await run(paris('2031-11-03', 8, 30));
    expect(await jobsOf(g.subId)).toHaveLength(0);
    expect(await jobsOf(h.subId)).toHaveLength(1); // J−7 le jour de l'activation : couvert
    const [motif] = await sql<{ reason: string }[]>`SELECT reason FROM annual_renewal_reminder_checks WHERE stripe_subscription_id = ${g.subId}`;
    expect(motif.reason).toBe('COVERAGE_UNCERTAIN');
  });

  it('ANN-J7-E2E-10 — e-mail désactivé dans le BO : annulé, jamais compté envoyé, pas relancé', async () => {
    const t = await titulaire({ end: paris('2031-12-20', 10) });
    await sql`INSERT INTO communication_channel_settings (event_code, channel, is_active, updated_at)
              VALUES ('email:SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER', 'email', false, now())
              ON CONFLICT (event_code, channel) DO UPDATE SET is_active = false`;
    await run(paris('2031-12-13', 8, 30));
    const [job] = await jobsOf(t.subId);
    expect(await send(job.id, paris('2031-12-13', 8, 31))).toMatchObject({ status: 'cancelled', error: 'CHANNEL_DISABLED' });
    expect(mailsTo(t.email)).toHaveLength(0);
    const [log] = await sql<{ status: string }[]>`SELECT status FROM email_logs WHERE email_job_id = ${job.id}`;
    expect(log.status).toBe('skipped');
    await run(paris('2031-12-14', 8, 30));
    expect((await jobsOf(t.subId)).map((j) => j.status)).toEqual(['cancelled']);
  });

  it('ANN-J7-E2E-11 — lien permanent : portail créé au clic, connexion puis retour, invité Duo refusé ; résiliation Stripe répercutée', async () => {
    const { POST } = await import('@/app/api/billing/create-customer-portal-session/route');
    const { generateAccessToken } = await import('@/lib/jwt');
    const jeton = (id: number, email: string) => generateAccessToken({ id, email, role: 'USER' as never, planType: 'PREMIUM' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
    const t = await titulaire({ end: paris('2032-01-20', 10) });

    // Ouvert « plusieurs jours après » : le lien ne porte aucune session, elle est créée maintenant.
    const n = etat.sessions.length;
    const ok = await POST(req('/api/billing/create-customer-portal-session', { cookie: `access_token=${await jeton(t.ownerUserId, t.email)}` }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).portal_url).toMatch(/^https:\/\/billing\.stripe\.com\/p\/session\//);
    // Lot 70B : toujours avec la configuration Verebona du portail (résiliation en fin de période).
    expect(etat.sessions.slice(n)).toEqual([{ customer: t.customer, return_url: `${APP}/mon-compte`, locale: 'fr', configuration: portalFake.verebonaConfigurations()[0].id }]);

    // Déconnecté : la page exige la connexion, puis y revient.
    const { middleware } = await import('@/middleware');
    const redir = await middleware(new NextRequest(`${APP}/mon-compte/abonnement/gerer`));
    expect(redir.status).toBe(307);
    expect(new URL(redir.headers.get('location')!).searchParams.get('returnUrl')).toBe('/mon-compte/abonnement/gerer');
    const { safeReturnUrl } = await import('@/lib/safe-redirect');
    expect(safeReturnUrl('/mon-compte/abonnement/gerer')).toBe('/mon-compte/abonnement/gerer');
    expect((await POST(req('/api/billing/create-customer-portal-session'))).status).toBe(401);

    // Invité Duo (jeton sur l'espace du titulaire) : refus explicite, aucune donnée du titulaire.
    const [{ id: duoId }] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, stripe_customer_id, stripe_subscription_id, activated_at)
      VALUES (${t.ownerUserId}, 'ACTIVE', ${t.customer}, ${t.subId}, now()) RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duoId} WHERE id = ${t.id}`;
    const invite = await make.user({ planType: 'PREMIUM_DUO' });
    await make.account({ owner: invite, plan: 'standard' });
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES (${duoId}, ${invite.id}, 'ACTIVE', 1, now())`;
    const tokInvite = await jeton(invite.id, invite.email);
    const m = etat.sessions.length;
    const refus = await POST(req('/api/billing/create-customer-portal-session', { cookie: `access_token=${tokInvite}` }));
    expect(refus.status).toBe(403);
    const corps = await refus.json();
    expect(corps.code).toBe('DUO_GUEST');
    expect(JSON.stringify(corps)).not.toContain(t.email);
    expect(JSON.stringify(corps)).not.toContain(t.customer);
    expect(etat.sessions.length).toBe(m); // aucune session créée

    // Résiliation depuis le portail Stripe → webhook customer.subscription.updated → état local, plus de rappel.
    (etat.subs.get(t.subId) as unknown as { cancel_at_period_end: boolean }).cancel_at_period_end = true;
    const { syncSubscriptionFromEvent } = await import('@/services/billing/subscription-sync.service');
    await syncSubscriptionFromEvent({ id: t.subId }, { source: 'webhook:customer.subscription.updated', notify: false }, async (id) => structuredClone(etat.subs.get(id)) as never);
    const [row] = await sql<{ cancel_at_period_end: boolean; billing_period: string }[]>`SELECT cancel_at_period_end, billing_period FROM account_subscriptions WHERE account_id = ${t.id}`;
    expect(row).toEqual({ cancel_at_period_end: true, billing_period: 'yearly' });
    const [acc] = await sql<{ subscription_status: string }[]>`SELECT subscription_status FROM accounts WHERE id = ${t.id}`;
    expect(acc.subscription_status).toBe('CANCELED');
    await run(paris('2032-01-13', 8, 30));
    expect(await jobsOf(t.subId)).toHaveLength(0);
  });

  it('ANN-J7-E2E-12 — BO : envois, demandes closes avec motif, état ; tâche créée suspendue puis réactivée', async () => {
    const t = await titulaire({ end: paris('2032-02-20', 10) });
    await run(paris('2032-02-13', 8, 30));
    const [job] = await jobsOf(t.subId);
    (etat.subs.get(t.subId) as unknown as { cancel_at_period_end: boolean }).cancel_at_period_end = true;
    await send(job.id, paris('2032-02-13', 8, 31));

    const admin = await make.user({ role: 'ADMIN' });
    const { generateAccessToken } = await import('@/lib/jwt');
    const tok = await generateAccessToken({ id: admin.id, email: admin.email, role: 'ADMIN' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
    const { GET } = await import('@/app/api/admin/communications/email-logs/route');
    const r = await (await GET(req(`/api/admin/communications/email-logs?type=SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER&recipient=${encodeURIComponent(t.email)}`, { method: 'GET', cookie: `access_token=${tok}` }))).json();
    expect(r.closedRequests).toEqual([expect.objectContaining({ jobId: job.id, status: 'cancelled', reason: 'CANCEL_AT_PERIOD_END' })]);
    const o = await (await GET(req('/api/admin/communications/email-logs?annualRenewal=1', { method: 'GET', cookie: `access_token=${tok}` }))).json();
    expect(o.annualRenewal).toMatchObject({ coverageFrom: '2030-01-01' });
    const conf = await (await GET(req('/api/admin/communications/email-logs?config=1', { method: 'GET', cookie: `access_token=${tok}` }))).json();
    expect(conf.config.templates.SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER).toBe(true);

    // Tâche planifiée : créée SUSPENDUE (0477), réactivée depuis le BO, exécutable.
    const [st] = await sql<{ admin_disabled: boolean }[]>`SELECT admin_disabled FROM scheduled_task_state WHERE code = 'subscription-annual-renewal-reminders'`;
    const runner = await import('@/services/scheduling/scheduled-task-runner');
    if (st.admin_disabled) expect((await runner.runTaskNow('subscription-annual-renewal-reminders')).status).toBe('admin_disabled');
    expect((await runner.setTaskAdminDisabled('subscription-annual-renewal-reminders', false, admin.id)).status).toBe('ok');
    const manuel = await runner.runTaskNow('subscription-annual-renewal-reminders', { waitMs: 30_000 });
    expect(manuel.status).toBe('finished');
    await runner.setTaskAdminDisabled('subscription-annual-renewal-reminders', true, admin.id);
  });
});
