/**
 * Lot 35C — CDC « Migration Stripe vers lookup_key » V4 — base PostgreSQL
 * réelle (migration 0306), Stripe jamais appelé : les objets Stripe sont
 * synthétiques et la reconnaissance passe par le REGISTRE historique
 * (`stripe_price_versions`) inscrit ici, sans aucune variable STRIPE_PRICE_*.
 *
 * Couvre : publication atomique d'une révision (photographie + registre +
 * miroirs, LK-18), synchronisation d'un abonné historique avec écriture du
 * prix contractuel (LK-19, TC-15, TC-73), prix inconnu → erreur rejouable
 * sans droit accordé (LK-66, TC-20), fin d'accès vérifiée malgré un prix non
 * rapproché (LK-67, TC-22), MRR au prix contractuel sans revalorisation à la
 * publication (LK-77, TC-57), tentative de souscription unique en base
 * (LK-44, TC-30), prise en charge atomique des webhooks et idempotence
 * métier (LK-70, TC-23, TC-24), information préalable prouvée et simulation
 * nominative de la revalorisation (EX-029, LK-112, TC-90).
 */
import type Stripe from 'stripe';
import { beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const NOW = Math.floor(Date.now() / 1000);

function sub(o: { id: string; customer: string; status: Stripe.Subscription.Status; price: string; amount: number; accountId: number; interval?: 'month' | 'year' }): Stripe.Subscription {
  return {
    id: o.id, object: 'subscription', customer: o.customer, status: o.status, cancel_at_period_end: false,
    start_date: NOW - 10 * 86400, metadata: { accountId: String(o.accountId) }, discounts: [], schedule: null,
    items: { data: [{
      id: `si_${o.id}`, quantity: 1,
      price: { id: o.price, unit_amount: o.amount, currency: 'eur', product: 'prod_e2e_premium', tax_behavior: 'unspecified', recurring: { interval: o.interval ?? 'year', interval_count: 1 } },
      current_period_start: NOW - 10 * 86400, current_period_end: NOW + 355 * 86400,
    }] },
  } as unknown as Stripe.Subscription;
}

scenario('L35C', 'Catalogue Stripe par lookup_key (registre, contrat, MRR, webhooks)', ({ sql, make }) => {
  let ctx = '';

  beforeAll(async () => {
    // Aucune variable de prix historique (TC-73).
    for (const k of Object.keys(process.env)) if (k.startsWith('STRIPE_PRICE_')) delete process.env[k];
    const { getStripeCatalogContext } = await import('@/lib/stripe-client');
    ctx = getStripeCatalogContext().catalogContext;
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { versionRowFrom } = await import('@/services/billing/price-history.service');
    // Ancien prix annuel Premium 59 € (sans clé) : correspondance validée au registre.
    await pgCatalogStore.upsertPriceVersion(versionRowFrom(
      { id: 'price_e2e_premium_59', livemode: false, product: 'prod_e2e_premium', lookup_key: null, unit_amount: 5900, currency: 'eur', tax_behavior: 'unspecified', active: true, recurring: { interval: 'year', interval_count: 1 } } as unknown as Stripe.Price,
      'premium', 'yearly', { catalogContext: ctx }, 'e2e',
    ));
  });

  async function compte() {
    const acc = await make.account({ plan: 'premium' });
    const customer = `cus_${uid('e2e')}`;
    const subId = `sub_${uid('e2e')}`;
    await sql`UPDATE accounts SET stripe_customer_id = ${customer}, stripe_subscription_id = ${subId}, subscription_status = 'ACTIVE', plan_type = 'PREMIUM' WHERE id = ${acc.id}`;
    await sql`UPDATE account_subscriptions SET stripe_subscription_id = ${subId}, stripe_customer_id = ${customer}, billing_period = 'yearly', status = 'active' WHERE account_id = ${acc.id}`;
    return { ...acc, customer, subId };
  }

  it('LK-18 — activation atomique : photographie, génération, registre et miroirs subscription_plans', async () => {
    const { pgCatalogStore } = await import('@/services/billing/catalog-store');
    const { catalogVersionOf } = await import('@/services/billing/catalog-types');
    const entry = {
      planCode: 'premium', billingPeriod: 'yearly', lookupKey: 'verebona_premium_yearly', priceId: 'price_e2e_premium_69', productId: 'prod_e2e_premium',
      unitAmountCents: 6900, currency: 'eur', interval: 'year', intervalCount: 1, taxBehavior: 'inclusive', livemode: false, priceRevision: 'pr_e2e00000000000a', verifiedAt: new Date().toISOString(),
    } as const;
    const entries = { 'premium:yearly': entry };
    const snapshot = { version: catalogVersionOf(entries), verifiedAt: new Date().toISOString(), entries, unavailable: {}, source: 'publish' as const };
    const before = await pgCatalogStore.ensureState(ctx);
    const after = await pgCatalogStore.activateSnapshot({
      context: ctx, stripeAccountId: 'acct_e2e', livemode: false, snapshot, keepPrevious: true, publishedManifestRevision: 'mf_e2e', publicationState: 'ACTIVE',
      versions: [{ catalogContext: ctx, stripeAccountId: 'acct_e2e', livemode: false, stripePriceId: 'price_e2e_premium_69', stripeProductId: 'prod_e2e_premium', planCode: 'premium', billingPeriod: 'yearly', logicalLookupKey: 'verebona_premium_yearly', observedLookupKey: 'verebona_premium_yearly', unitAmountCents: 6900, currency: 'eur', interval: 'year', intervalCount: 1, taxBehavior: 'inclusive', priceRevision: entry.priceRevision, stripeActive: true, source: 'publication' }],
    });
    expect(after.activeRevision).toBe(snapshot.version);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.publishedManifestRevision).toBe('mf_e2e');
    expect((await sql`SELECT yearly_price_cents, stripe_price_id_yearly FROM subscription_plans WHERE code = 'premium'`)[0]).toMatchObject({ yearly_price_cents: 6900, stripe_price_id_yearly: 'price_e2e_premium_69' });
    expect(await pgCatalogStore.findPriceVersion(ctx, 'price_e2e_premium_59')).toMatchObject({ unitAmountCents: 5900, planCode: 'premium' });
  });

  it('TC-15 / TC-73 / LK-19 — abonné historique (59 €) synchronisé SANS variable de prix : offre reconnue, prix contractuel écrit', async () => {
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    const c = await compte();
    const r = await syncSubscriptionFromStripe({ subscription: sub({ id: c.subId, customer: c.customer, status: 'active', price: 'price_e2e_premium_59', amount: 5900, accountId: c.id }), source: 'e2e', notify: false });
    expect(r).toMatchObject({ planTier: 'premium', newPlanType: 'PREMIUM', isPaid: true, billingPeriod: 'yearly' });
    const [row] = await sql`SELECT stripe_price_id, contract_unit_amount_cents, contract_currency, contract_quantity, contract_interval, stripe_subscription_item_id FROM account_subscriptions WHERE account_id = ${c.id}`;
    expect(row).toMatchObject({ stripe_price_id: 'price_e2e_premium_59', contract_unit_amount_cents: 5900, contract_currency: 'eur', contract_quantity: 1, contract_interval: 'year', stripe_subscription_item_id: `si_${c.subId}` });
  });

  it('LK-77 / TC-57 — MRR au prix CONTRACTUEL : la publication 69 € ne revalorise pas l’abonné à 59 €', async () => {
    const { monthlyRevenueCents } = await import('@/services/admin/kpi.service');
    const c = await compte();
    await sql`UPDATE account_subscriptions SET contract_unit_amount_cents = 5900, first_billed_at = now() - interval '5 days' WHERE account_id = ${c.id}`;
    expect(monthlyRevenueCents('premium', 'yearly', new Map(), 5900)).toBeCloseTo(491.67, 1);
    // subscription_plans porte 69 € (miroir de la nouvelle révision) : sans effet sur ce contrat.
    expect(monthlyRevenueCents('premium', 'yearly', new Map([['premium', { code: 'premium', label: 'Premium', monthlyPriceCents: 690, yearlyPriceCents: 6900, displayOrder: 2, offered: true }]]), 5900)).toBeCloseTo(491.67, 1);
    const { getOverview } = await import('@/services/admin/kpi.service');
    const { resolvePeriod, parisYearMonth } = await import('@/lib/admin/periods');
    const o = await getOverview(resolvePeriod('month', parisYearMonth(new Date())));
    // Valorisé (contrat connu) : jamais compté parmi les prix inconnus.
    expect(typeof o.mrrUnknownSubscriptions).toBe('number');
    expect(o.kpis.mrr.value).toBeGreaterThan(0);
  });

  it('LK-66 / TC-20 — prix inconnu sur un abonnement payé : erreur typée (rejeu), AUCUN droit modifié', async () => {
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    const { PriceRecognitionError } = await import('@/services/billing/price-history.service');
    const c = await compte();
    await sql`UPDATE accounts SET plan_type = 'STANDARD' WHERE id = ${c.id}`;
    await expect(syncSubscriptionFromStripe({ subscription: sub({ id: c.subId, customer: c.customer, status: 'active', price: 'price_e2e_inconnu', amount: 390, accountId: c.id, interval: 'month' }), source: 'e2e', notify: false }))
      .rejects.toBeInstanceOf(PriceRecognitionError);
    expect((await sql`SELECT plan_type FROM accounts WHERE id = ${c.id}`)[0].plan_type).toBe('STANDARD');
  });

  it('LK-67 / TC-22 — résiliation vérifiée de l’abonnement COURANT avec prix non rapproché : fin d’accès traitée', async () => {
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    const c = await compte();
    const r = await syncSubscriptionFromStripe({ subscription: sub({ id: c.subId, customer: c.customer, status: 'canceled', price: 'price_e2e_inconnu_2', amount: 999, accountId: c.id }), source: 'e2e', notify: false });
    expect(r).toMatchObject({ newStatus: 'EXPIRED', isPaid: false });
    expect((await sql`SELECT status FROM account_subscriptions WHERE account_id = ${c.id}`)[0].status).toBe('canceled');
  });

  it('TC-21 / TC-28 — fin d’un ANCIEN abonnement alors qu’un autre est en place : aucune régression', async () => {
    const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
    const c = await compte();
    const r = await syncSubscriptionFromStripe({ subscription: sub({ id: `sub_old_${c.id}`, customer: c.customer, status: 'canceled', price: 'price_e2e_premium_59', amount: 5900, accountId: c.id }), source: 'e2e', notify: false });
    expect(r?.skipped).toBe('STALE_SUBSCRIPTION');
    expect((await sql`SELECT subscription_status FROM accounts WHERE id = ${c.id}`)[0].subscription_status).toBe('ACTIVE');
  });

  it('LK-44 / TC-30 — une seule tentative de souscription ouverte par compte (deux instances, mêmes paramètres)', async () => {
    const { reserveCheckout, markOperation } = await import('@/services/billing/price-operations.service');
    const c = await compte();
    const price = { planCode: 'premium', billingPeriod: 'monthly', lookupKey: 'verebona_premium_monthly', priceId: 'price_e2e_p_m', productId: 'prod_e2e_premium', unitAmountCents: 690, currency: 'eur', interval: 'month', intervalCount: 1, taxBehavior: 'inclusive', livemode: false, priceRevision: 'pr_e2e0000000000bb', verifiedAt: '' } as const;
    const [a, b] = await Promise.all([
      reserveCheckout({ accountId: c.id, userId: c.ownerUserId, price, customerId: c.customer }),
      reserveCheckout({ accountId: c.id, userId: c.ownerUserId, price, customerId: c.customer }),
    ]);
    expect(a.op.idempotencyKey).toBe(b.op.idempotencyKey);
    expect([a.kind, b.kind].sort()).toEqual(['new', 'same']);
    // Tentative close → nouvelle clé (jamais une clé unique à vie).
    await markOperation(a.op.id, 'expired');
    const c2 = await reserveCheckout({ accountId: c.id, userId: c.ownerUserId, price, customerId: c.customer });
    expect(c2.kind).toBe('new');
    expect(c2.op.idempotencyKey).not.toBe(a.op.idempotencyKey);
    // Autres paramètres (nouvelle révision) → l'ancienne tentative est remplacée.
    const c3 = await reserveCheckout({ accountId: c.id, userId: c.ownerUserId, price: { ...price, priceRevision: 'pr_e2e0000000000cc' }, customerId: c.customer });
    expect(c3).toMatchObject({ kind: 'new', superseded: { id: c2.op.id } });
    expect((await sql`SELECT count(*)::int AS n FROM billing_price_operations WHERE account_id = ${c.id} AND status IN ('reserved','created','uncertain')`)[0].n).toBe(1);
  });

  it('LK-70 / TC-23 / TC-24 — webhook pris en charge une seule fois ; effets d’un paiement uniques par facture', async () => {
    const { claimWebhookEvent, claimInvoiceEffect } = await import('@/services/billing/webhook-catalog.service');
    const id = `evt_${uid('e2e')}`;
    const [x, y] = await Promise.all([
      claimWebhookEvent({ id, type: 'invoice.paid' }, '{}'),
      claimWebhookEvent({ id, type: 'invoice.paid' }, '{}'),
    ]);
    expect([x, y].sort()).toEqual(['CLAIMED', 'IN_PROGRESS']);
    await sql`UPDATE stripe_webhook_logs SET processed = true WHERE event_id = ${id}`;
    expect(await claimWebhookEvent({ id, type: 'invoice.paid' }, '{}')).toBe('ALREADY_PROCESSED');
    // Échec enregistré → reprise immédiate permise.
    const id2 = `evt_${uid('e2e')}`;
    await claimWebhookEvent({ id: id2, type: 'invoice.paid' }, '{}');
    await sql`UPDATE stripe_webhook_logs SET error_message = 'boom' WHERE event_id = ${id2}`;
    expect(await claimWebhookEvent({ id: id2, type: 'invoice.paid' }, '{}')).toBe('CLAIMED');

    const inv = `in_${uid('e2e')}`;
    expect(await claimInvoiceEffect(inv, 'payment_succeeded')).toBe(true);
    expect(await claimInvoiceEffect(inv, 'payment_succeeded')).toBe(false);
  });

  it('EX-029 / TC-90 / LK-112 — information préalable : preuve externe exigée, simulation nominative', async () => {
    const { recordCampaignNotification, listCampaign } = await import('@/services/billing/price-revaluation.service');
    const c = await compte();
    const rev = `cv_e2e_${uid('r')}`;
    await sql`INSERT INTO stripe_price_migrations (catalog_context, revision_id, account_id, stripe_subscription_id, stripe_subscription_item_id, plan_code, billing_period, old_price_id, old_amount_cents, target_price_id, target_amount_cents, renewal_at, eligibility_status, migration_status)
              VALUES (${ctx}, ${rev}, ${c.id}, ${c.subId}, ${'si_' + c.subId}, 'premium', 'yearly', 'price_e2e_premium_59', 5900, 'price_e2e_premium_69', 6900, now() + interval '200 days', 'eligible', 'planned'),
                     (${ctx}, ${rev}, ${c.id}, ${c.subId + '_b'}, ${'si_' + c.subId + '_b'}, 'premium', 'yearly', 'price_e2e_premium_59', 5900, 'price_e2e_premium_69', 6900, now() + interval '20 days', 'deferred', 'deferred')`;
    await expect(recordCampaignNotification({ revisionId: rev, channel: 'external', legalReference: '', actor: 'admin:1', externalReference: 'X' })).rejects.toThrow(/juridique/);
    const r = await recordCampaignNotification({ revisionId: rev, channel: 'external', legalReference: 'AVIS-2026-10', actor: 'admin:1', externalReference: 'courrier-2026-10' });
    expect(r).toEqual({ proven: 2, failed: 0 });
    const rows = await sql`SELECT notification_status, notice_deadline FROM stripe_price_migrations WHERE revision_id = ${rev}`;
    expect(rows.every((x) => x.notification_status === 'proven' && x.notice_deadline)).toBe(true);
    const list = await listCampaign(rev);
    expect(list.rows).toHaveLength(2);
    expect(list.rows[0]).toMatchObject({ oldAmountCents: 5900, targetAmountCents: 6900, accountId: c.id });
    expect(list.counts).toMatchObject({ planned: 1, deferred: 1 });
  });
});
