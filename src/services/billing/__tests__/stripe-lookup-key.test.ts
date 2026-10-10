/**
 * Lot 35C — CDC « Migration Stripe vers lookup_key » V4 : catalogue par clés
 * stables, registre historique, publication contrôlée, retour arrière,
 * revalorisation (règles pures), portail, webhooks. Les identifiants de
 * recette (TC-xx, RX-xx, EX-xxx, LK-xx) nomment les critères couverts.
 *
 * Stripe et la base sont simulés (helpers/fake-stripe-catalog) ; le
 * comportement en base réelle est couvert par l'e2e `l35c-stripe-lookup-key`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

vi.mock('@/db', () => ({ pgClient: { unsafe: async () => [] }, db: {} }));
const campaigns: unknown[] = [];
vi.mock('../price-revaluation.service', async (orig) => {
  const real = await orig<typeof import('../price-revaluation.service')>();
  return {
    ...real,
    createRevaluationCampaign: async (input: unknown) => { campaigns.push(input); return { inventoried: 0, planned: 0, deferred: 0, excluded: 0, skippedSamePrice: 0 }; },
    cancelCampaign: async () => 0,
  };
});

import { CATALOG_COUPLES, lookupKeyFor, parseBillingPeriodInput, parsePlanInput, formatEuroCents } from '@/lib/billing/plan-catalog';
import { BillingCatalogError, priceRevisionOf, validateSalePrice, groupByLookupKey, catalogVersionOf } from '../catalog-types';
import {
  __setCatalogDepsForTests, assertDisplayedRevision, buildPublicCatalog, memoryTtlMs, presentationTtlSeconds, refreshCatalog, resolveCurrentPrice,
} from '../price-catalog.service';
import { PRICING_MANIFEST, manifestRevision, validateManifest } from '../pricing-manifest';
import { abandonPublication, diffManifest, publishCodeCatalog, rollbackCatalog, shouldAutoPublish, AUTO_PUBLISH_DELAY_MS } from '../catalog-publication.service';
import { classifyFetchedPrice, resolveHistoricalPrice, type HistoryDeps } from '../price-history.service';
import { buildRevaluationPhases, changedCouples, evaluateEligibility, revaluationTiming, RENEWAL_SAFETY_MS } from '../price-revaluation.service';
import { acceptedPrices, portalFingerprint, portalProductsFor } from '../portal-configuration.service';
import { claimInvoiceEffect, claimWebhookEvent } from '../webhook-catalog.service';
import { PRODUCTS, fakeStripe, memoryStore, oldGrid, price, testDeps } from './helpers/fake-stripe-catalog';

const CTX = 'test:preprod';
const COUPLE = (k: string) => CATALOG_COUPLES.find((c) => c.lookupKey === k)!;

let store: ReturnType<typeof memoryStore>;
let fs: ReturnType<typeof fakeStripe>;
let t: ReturnType<typeof testDeps>;

async function bootstrap(prices = oldGrid()) {
  store = memoryStore();
  fs = fakeStripe(prices, PRODUCTS);
  t = testDeps(store, fs.client);
  __setCatalogDepsForTests(t.deps);
  const r = await refreshCatalog({ source: 'test' }, t.deps);
  return r;
}

beforeEach(() => {
  campaigns.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ─── Dictionnaire, manifeste, entrées (LK-01, LK-08, LK-37, LK-101) ─────────

describe('dictionnaire et manifeste', () => {
  it('LK-01 — six clés stables, convention du seed, sans montant ni environnement', () => {
    expect(CATALOG_COUPLES.map((c) => c.lookupKey)).toEqual([
      'verebona_standard_monthly', 'verebona_standard_yearly', 'verebona_premium_monthly',
      'verebona_premium_yearly', 'verebona_premium_duo_monthly', 'verebona_premium_duo_yearly',
    ]);
    expect(lookupKeyFor('premium_duo', 'yearly')).toBe('verebona_premium_duo_yearly');
  });

  it('LK-101 / RX-01 — manifeste unique : 390/3900, 690/6900, 990/9900 centimes TTC en EUR', () => {
    expect(PRICING_MANIFEST.standard.monthly.unitAmountCents).toBe(390);
    expect(PRICING_MANIFEST.standard.yearly.unitAmountCents).toBe(3900);
    expect(PRICING_MANIFEST.premium.monthly.unitAmountCents).toBe(690);
    expect(PRICING_MANIFEST.premium.yearly.unitAmountCents).toBe(6900);
    expect(PRICING_MANIFEST.premium_duo.monthly.unitAmountCents).toBe(990);
    expect(PRICING_MANIFEST.premium_duo.yearly.unitAmountCents).toBe(9900);
    for (const c of CATALOG_COUPLES) expect(PRICING_MANIFEST[c.planCode][c.billingPeriod]).toMatchObject({ currency: 'eur', taxBehavior: 'inclusive' });
    expect(validateManifest()).toEqual([]);
    expect(manifestRevision()).toMatch(/^mf_[a-f0-9]{16}$/);
  });

  it('TC-09 — plan inconnu, objet au lieu de chaîne, cadence invalide : refus explicite, jamais Premium/annuel par défaut', () => {
    expect(parsePlanInput('gold')).toEqual({ ok: false, code: 'INVALID_PLAN' });
    expect(parsePlanInput({ plan: 'premium' })).toEqual({ ok: false, code: 'INVALID_PLAN' });
    expect(parsePlanInput(undefined)).toEqual({ ok: false, code: 'INVALID_PLAN' });
    expect(parsePlanInput('premium_pro')).toEqual({ ok: false, code: 'INVALID_PLAN' });
    expect(parsePlanInput('DUO')).toEqual({ ok: true, plan: 'premium_duo' });
    expect(parseBillingPeriodInput('weekly')).toEqual({ ok: false, code: 'INVALID_BILLING_PERIOD' });
    expect(parseBillingPeriodInput(undefined)).toEqual({ ok: false, code: 'INVALID_BILLING_PERIOD' });
    expect(parseBillingPeriodInput(['yearly'])).toEqual({ ok: false, code: 'INVALID_BILLING_PERIOD' });
  });

  it('LK-32 — formatage Intl fr-FR EUR (calculs en centimes entiers)', () => {
    expect(formatEuroCents(390).replace(/ | /g, ' ')).toBe('3,90 €');
    expect(formatEuroCents(3900).replace(/ | /g, ' ')).toBe('39,00 €');
  });
});

// ─── Validation d'un Price (LK-10 à LK-16) ───────────────────────────────────

describe('validation des prix de vente', () => {
  const ok = { livemode: false, saleProductId: 'prod_standard', verifiedAt: '2026-10-10T00:00:00Z' };
  const std = COUPLE('verebona_standard_monthly');
  const base = { id: 'p1', amount: 390, interval: 'month' as const, product: 'prod_standard', key: 'verebona_standard_monthly' };

  it('TC-04 — prix inactif ou produit inactif : refus', () => {
    expect(validateSalePrice(price({ ...base, active: false }), std, ok)).toMatchObject({ ok: false, code: 'PRICE_INACTIVE' });
    const p = { ...price(base), product: { id: 'prod_standard', active: false, metadata: {} } } as unknown as Stripe.Price;
    expect(validateSalePrice(p, std, ok)).toMatchObject({ ok: false, code: 'PRODUCT_INACTIVE' });
  });

  it('TC-05 — prix du mauvais mode : refus', () => {
    expect(validateSalePrice(price({ ...base, livemode: true }), std, ok)).toMatchObject({ ok: false, code: 'WRONG_MODE' });
  });

  it('TC-06 — clé annuelle vers un prix mensuel, ou intervalle de deux ans : refus', () => {
    const yearly = COUPLE('verebona_standard_yearly');
    expect(validateSalePrice(price({ ...base, key: 'verebona_standard_yearly' }), yearly, ok)).toMatchObject({ ok: false, code: 'WRONG_INTERVAL' });
    const twoYears = price({ ...base, recurring: { interval: 'year', interval_count: 2, usage_type: 'licensed' } as Stripe.Price.Recurring, key: 'verebona_standard_yearly' });
    expect(validateSalePrice(twoYears, yearly, ok)).toMatchObject({ ok: false, code: 'WRONG_INTERVAL' });
  });

  it('TC-07 — devise, paliers, usage mesuré, montant nul, prix libre, quantité transformée : refus', () => {
    expect(validateSalePrice(price({ ...base, currency: 'usd' }), std, ok)).toMatchObject({ code: 'WRONG_CURRENCY' });
    expect(validateSalePrice(price({ ...base, billing_scheme: 'tiered' }), std, ok)).toMatchObject({ code: 'NOT_PER_UNIT' });
    expect(validateSalePrice(price({ ...base, recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } as Stripe.Price.Recurring }), std, ok)).toMatchObject({ code: 'USAGE_METERED' });
    expect(validateSalePrice(price({ ...base, amount: 0, unit_amount: 0 }), std, ok)).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(validateSalePrice(price({ ...base, custom_unit_amount: { maximum: null, minimum: null, preset: null } }), std, ok)).toMatchObject({ code: 'CUSTOM_AMOUNT' });
    expect(validateSalePrice(price({ ...base, transform_quantity: { divide_by: 2, round: 'up' } }), std, ok)).toMatchObject({ code: 'TRANSFORM_QUANTITY' });
  });

  it('TC-08 — clé Duo vers le produit Standard, ou métadonnées contradictoires : refus', () => {
    const duo = COUPLE('verebona_premium_duo_monthly');
    expect(validateSalePrice(price({ ...base, key: 'verebona_premium_duo_monthly' }), duo, { ...ok, saleProductId: 'prod_duo' })).toMatchObject({ ok: false, code: 'PRODUCT_NOT_APPROVED' });
    expect(validateSalePrice(price({ ...base, metadata: { verebona_plan: 'premium' } }), std, ok)).toMatchObject({ ok: false, code: 'METADATA_CONFLICT' });
    // Ancienne convention produit `verebona_<offre>` acceptée (LK-04).
    expect(validateSalePrice(price({ ...base, metadata: { verebona_plan: 'verebona_standard' } }), std, ok).ok).toBe(true);
  });

  it('TC-12 / TC-13 / LK-16 — TTC : inclusive accepté, unspecified historique accepté sans taxe ajoutée, exclusive refusé', () => {
    expect(validateSalePrice(price(base), std, ok)).toMatchObject({ ok: true, resolved: { taxBehavior: 'inclusive', unitAmountCents: 390 } });
    expect(validateSalePrice(price({ ...base, tax_behavior: 'unspecified' }), std, ok).ok).toBe(true);
    expect(validateSalePrice(price({ ...base, tax_behavior: 'exclusive' }), std, ok)).toMatchObject({ ok: false, code: 'TAX_EXCLUSIVE' });
  });

  it('LK-13 / TC-79 — aucun montant constant : une future grille (4,90 €) est valide', () => {
    expect(validateSalePrice(price({ ...base, amount: 490 }), std, ok)).toMatchObject({ ok: true, resolved: { unitAmountCents: 490 } });
  });

  it('LK-30 — révision stable : même prix → même révision ; nouveau Price → révision différente', () => {
    const a = priceRevisionOf({ priceId: 'p1', unitAmountCents: 390, currency: 'eur', interval: 'month', intervalCount: 1, taxBehavior: 'inclusive' });
    expect(priceRevisionOf({ priceId: 'p1', unitAmountCents: 390, currency: 'eur', interval: 'month', intervalCount: 1, taxBehavior: 'inclusive' })).toBe(a);
    expect(priceRevisionOf({ priceId: 'p2', unitAmountCents: 390, currency: 'eur', interval: 'month', intervalCount: 1, taxBehavior: 'inclusive' })).not.toBe(a);
  });

  it('TC-02 — regroupement par clé, jamais par position', () => {
    const g = groupByLookupKey([price({ ...base, id: 'b', key: 'verebona_premium_monthly' }), price({ ...base, id: 'a' })]);
    expect(g.get('verebona_standard_monthly')?.[0].id).toBe('a');
    expect(g.get('verebona_premium_monthly')?.[0].id).toBe('b');
  });
});

// ─── Résolution courante (LK-09, LK-23, LK-34) ───────────────────────────────

describe('résolution des prix courants', () => {
  it('TC-01 — six couples résolus (clé, produit, cadence, devise, montant), malgré l’ordre inversé de Stripe', async () => {
    const r = await bootstrap();
    expect(r.status).toBe('adopted');
    for (const c of CATALOG_COUPLES) {
      const p = await resolveCurrentPrice(c.planCode, c.billingPeriod, {}, t.deps);
      expect(p).toMatchObject({ lookupKey: c.lookupKey, currency: 'eur', interval: c.interval });
    }
    expect((await resolveCurrentPrice('premium_duo', 'yearly', {}, t.deps)).unitAmountCents).toBe(8900);
    expect(store.listApprovedProducts(CTX)).resolves.toHaveLength(3);
  });

  it('TC-03 — clé absente : couple indisponible (PRICE_UNAVAILABLE), les autres restent vendables (LK-94)', async () => {
    await bootstrap(oldGrid().filter((p) => p.id !== 'p_pre_y'));
    await expect(resolveCurrentPrice('premium', 'yearly', {}, t.deps)).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE', httpStatus: 503 });
    await expect(resolveCurrentPrice('premium', 'monthly', {}, t.deps)).resolves.toMatchObject({ priceId: 'p_pre_m' });
  });

  it('LK-23 — paiement : prix relu chez Stripe ; modifié depuis la photographie → refus (jamais un mauvais prix)', async () => {
    await bootstrap();
    await expect(resolveCurrentPrice('standard', 'monthly', { forPayment: true }, t.deps)).resolves.toMatchObject({ priceId: 'p_std_m' });
    fs.prices.set('p_std_m', { ...fs.prices.get('p_std_m')!, active: false });
    await expect(resolveCurrentPrice('standard', 'monthly', { forPayment: true }, t.deps)).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    expect(t.anomalies.some((a) => a.fingerprint.includes('verebona_standard_monthly'))).toBe(true);
  });

  it('TC-76 — Stripe indisponible au paiement : STRIPE_UNAVAILABLE (503), aucune substitution', async () => {
    await bootstrap();
    fs.failOn.retrieve = true;
    await expect(resolveCurrentPrice('premium', 'monthly', { forPayment: true }, t.deps)).rejects.toMatchObject({ code: 'STRIPE_UNAVAILABLE', httpStatus: 503 });
  });

  it('BILLING_CATALOG_UPDATING pendant la courte fenêtre d’activation seulement', async () => {
    await bootstrap();
    await store.setPublication(CTX, { state: 'READY', activatingUntil: new Date('2026-10-10T10:01:00Z') });
    await expect(resolveCurrentPrice('premium', 'monthly', { forPayment: true }, t.deps)).rejects.toMatchObject({ code: 'BILLING_CATALOG_UPDATING' });
    // Affichage non bloqué.
    await expect(resolveCurrentPrice('premium', 'monthly', {}, t.deps)).resolves.toBeTruthy();
  });

  it('TC-35 / TC-36 / LK-34 — révision absente → 409 CONFIRMATION ; différente → 409 PRICE_CHANGED avec le nouveau tarif', async () => {
    await bootstrap();
    const p = await resolveCurrentPrice('premium', 'yearly', {}, t.deps);
    expect(() => assertDisplayedRevision(p, null)).toThrow(BillingCatalogError);
    try { assertDisplayedRevision(p, 'pr_0000000000000000'); } catch (e) {
      expect(e).toMatchObject({ code: 'PRICE_CHANGED', httpStatus: 409, offer: { unit_amount_cents: 5900, price_revision: p.priceRevision } });
      expect((e as BillingCatalogError).toBody()).toMatchObject({ code: 'PRICE_CHANGED', details: { offer: { unit_amount_cents: 5900 } } });
    }
    expect(() => assertDisplayedRevision(p, p.priceRevision)).not.toThrow();
  });

  it('LK-34 — une hausse Premium n’invalide pas la confirmation d’un Standard inchangé', async () => {
    await bootstrap();
    const std = await resolveCurrentPrice('standard', 'monthly', {}, t.deps);
    fs.prices.set('p_pre_m2', price({ id: 'p_pre_m2', amount: 690, product: 'prod_premium', key: null }));
    await fs.client.prices.update('p_pre_m2', { lookup_key: 'verebona_premium_monthly', transfer_lookup_key: true });
    await refreshCatalog({ source: 'test' }, t.deps);
    const std2 = await resolveCurrentPrice('standard', 'monthly', {}, t.deps);
    expect(std2.priceRevision).toBe(std.priceRevision);
  });
});

// ─── Synchronisation, cache, dérive (LK-22, LK-25, LK-28, LK-83) ─────────────

describe('synchronisation du catalogue', () => {
  it('TC-63 — nouveau prix + transfert de la même clé (sans déploiement) : ventes suivantes au nouveau tarif', async () => {
    await bootstrap();
    fs.prices.set('p_std_m_new', price({ id: 'p_std_m_new', amount: 390, product: 'prod_standard' }));
    await fs.client.prices.update('p_std_m_new', { lookup_key: 'verebona_standard_monthly', transfer_lookup_key: true });
    expect((await refreshCatalog({ source: 'webhook:price.updated' }, t.deps)).status).toBe('adopted');
    await expect(resolveCurrentPrice('standard', 'monthly', { forPayment: true }, t.deps)).resolves.toMatchObject({ priceId: 'p_std_m_new', unitAmountCents: 390 });
    // L'ancien prix reste reconnu au registre (TC-15).
    expect(await store.findPriceVersion(CTX, 'p_std_m')).toMatchObject({ planCode: 'standard', unitAmountCents: 290 });
  });

  it('TC-65 / LK-22 — rafraîchissement inchangé : aucune nouvelle génération ; caches bornés (30 s mémoire, ≤ 5 min HTTP)', async () => {
    await bootstrap();
    const g = (await store.getState(CTX))!.generation;
    expect((await refreshCatalog({ source: 'test' }, t.deps)).status).toBe('unchanged');
    expect((await store.getState(CTX))!.generation).toBe(g);
    expect(memoryTtlMs({ BILLING_CATALOG_MEMORY_TTL_MS: '600000' } as unknown as NodeJS.ProcessEnv)).toBe(30_000);
    expect(presentationTtlSeconds({ BILLING_CATALOG_PRESENTATION_TTL_S: '9999' } as unknown as NodeJS.ProcessEnv)).toBe(300);
  });

  it('TC-84 / RX-03 — publication en échec : la synchronisation n’adopte JAMAIS l’état hybride des clés', async () => {
    await bootstrap();
    await store.setPublication(CTX, { state: 'FAILED', error: 'transfer' });
    fs.prices.set('p_x', price({ id: 'p_x', amount: 390, product: 'prod_standard' }));
    await fs.client.prices.update('p_x', { lookup_key: 'verebona_standard_monthly', transfer_lookup_key: true });
    expect((await refreshCatalog({ source: 'test' }, t.deps))).toMatchObject({ status: 'skipped', reason: 'PUBLICATION_FAILED' });
    await expect(resolveCurrentPrice('standard', 'monthly', {}, t.deps)).resolves.toMatchObject({ priceId: 'p_std_m', unitAmountCents: 290 });
  });

  it('RX-16 — Stripe indisponible : révision active conservée (ancienne grille), erreur notée', async () => {
    await bootstrap();
    fs.failOn.list = true;
    expect((await refreshCatalog({ source: 'test' }, t.deps)).status).toBe('failed');
    await expect(resolveCurrentPrice('premium', 'yearly', {}, t.deps)).resolves.toMatchObject({ unitAmountCents: 5900 });
    expect((await store.getState(CTX))!.lastSyncError).toContain('Stripe down');
  });

  it('LK-83 — clé absente : initialisée sur le prix V2 configuré (double lecture de transition), sans voler une clé', async () => {
    const grid = oldGrid().map((p) => (p.id === 'p_std_m' ? { ...p, lookup_key: null } : p));
    store = memoryStore();
    fs = fakeStripe(grid, PRODUCTS);
    t = testDeps(store, fs.client, { env: { STRIPE_EXPECTED_MODE: 'test', STRIPE_PRICE_STANDARD_MONTHLY: 'p_std_m' } as unknown as NodeJS.ProcessEnv });
    await refreshCatalog({ source: 'bootstrap' }, t.deps);
    expect(fs.prices.get('p_std_m')!.lookup_key).toBe('verebona_standard_monthly');
    await expect(resolveCurrentPrice('standard', 'monthly', {}, t.deps)).resolves.toMatchObject({ priceId: 'p_std_m' });
  });

  it('TC-80 — compte Stripe différent pour le même contexte (base restaurée) : anomalie, pas de mélange', async () => {
    await bootstrap();
    (await store.getState(CTX));
    store.states.get(CTX)!.stripeAccountId = 'acct_autre';
    await refreshCatalog({ source: 'test' }, t.deps);
    expect(t.anomalies.some((a) => a.fingerprint.endsWith('account-changed'))).toBe(true);
    expect((await store.getState(CTX))!.previousSnapshot).toBeNull();
  });

  it('TC-14 / LK-29 — catalogue public : aucun identifiant de prix, client ou secret ; montants et révisions', async () => {
    await bootstrap();
    const pub = buildPublicCatalog(await store.getState(CTX), new Date('2026-10-10T10:00:10Z'));
    expect(pub.status).toBe('ok');
    expect(pub.offers).toHaveLength(6);
    const json = JSON.stringify(pub);
    expect(json).not.toMatch(/p_std_m|prod_|acct_|sk_|cus_|sub_/);
    expect(pub.offers[0]).toEqual(expect.objectContaining({ plan_code: 'standard', billing_period: 'monthly', unit_amount_cents: 290, currency: 'eur', interval: 'month', interval_count: 1, available: true, tax_included: true }));
  });

  it('LK-28 / TC-76 — photographie périmée ET Stripe en échec : lecture seule, achats désactivés', async () => {
    await bootstrap();
    await store.setSyncError(CTX, 'Stripe down');
    const pub = buildPublicCatalog(await store.getState(CTX), new Date('2026-10-10T11:00:00Z'));
    expect(pub).toMatchObject({ status: 'stale', purchasable: false });
    expect(pub.offers).toHaveLength(6);
  });

  it('TC-61 — aucun catalogue : indisponible, aucune grille de secours', () => {
    expect(buildPublicCatalog(null, new Date())).toMatchObject({ status: 'unavailable', purchasable: false, offers: [] });
  });
});

// ─── Publication de la grille du code (LK-102 à LK-105, EX-007 à EX-015) ─────

describe('publication contrôlée', () => {
  it('diff : grille ancienne → six créations ; grille identique → aucune', async () => {
    await bootstrap();
    const st = await store.getState(CTX);
    expect(diffManifest(PRICING_MANIFEST, st!.activeSnapshot).filter((d) => d.action === 'create')).toHaveLength(6);
  });

  it('TC-70 — simulation : aucune écriture Stripe ni base', async () => {
    await bootstrap();
    fs.calls.length = 0;
    const runs = store.runs.length;
    const r = await publishCodeCatalog({ trigger: 'manual', dryRun: true }, t.deps);
    expect(r.status).toBe('simulated');
    expect(fs.calls.filter((c) => c.startsWith('prices.create') || c.startsWith('prices.update'))).toEqual([]);
    expect(store.runs.length).toBe(runs);
  });

  it('TC-82 / RX-01 — six nouveaux prix créés sous les produits existants, six clés transférées, révision activée', async () => {
    await bootstrap();
    const r = await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    expect(r.status).toBe('published');
    const amounts = await Promise.all(CATALOG_COUPLES.map((c) => resolveCurrentPrice(c.planCode, c.billingPeriod, {}, t.deps).then((p) => p.unitAmountCents)));
    expect(amounts).toEqual([390, 3900, 690, 6900, 990, 9900]);
    for (const c of CATALOG_COUPLES) {
      const p = await resolveCurrentPrice(c.planCode, c.billingPeriod, {}, t.deps);
      expect(p.taxBehavior).toBe('inclusive');
      expect(p.productId).toBe(c.planCode === 'premium_duo' ? 'prod_duo' : `prod_${c.planCode}`);
    }
    // Anciens prix : toujours actifs (aucun archivage, LK-60) et au registre.
    expect(fs.prices.get('p_pre_y')!.active).toBe(true);
    expect(await store.findPriceVersion(CTX, 'p_pre_y')).toBeTruthy();
    expect((await store.getState(CTX))!.publishedManifestRevision).toBe(manifestRevision());
    expect(campaigns).toHaveLength(1);
    expect(fs.calls).toContain('portal.create');
  });

  it('TC-83 / TC-72 — relance : aucun Price supplémentaire, aucune double revalorisation', async () => {
    await bootstrap();
    await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    const created = fs.calls.filter((c) => c === 'prices.create').length;
    const r2 = await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    expect(r2.status).toBe('noop');
    expect(fs.calls.filter((c) => c === 'prices.create').length).toBe(created);
    expect(campaigns).toHaveLength(1);
  });

  it('TC-81 / RX-02 — un seul montant modifié dans le code : un seul nouveau Price, cinq inchangés', async () => {
    await bootstrap();
    await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    const before = fs.calls.filter((c) => c === 'prices.create').length;
    const manifest = JSON.parse(JSON.stringify(PRICING_MANIFEST));
    manifest.premium.monthly.unitAmountCents = 790;
    const r = await publishCodeCatalog({ trigger: 'manual', manifest }, t.deps);
    expect(r.status).toBe('published');
    expect(fs.calls.filter((c) => c === 'prices.create').length).toBe(before + 1);
    expect((await resolveCurrentPrice('premium', 'monthly', {}, t.deps)).unitAmountCents).toBe(790);
    expect((await resolveCurrentPrice('premium', 'yearly', {}, t.deps)).unitAmountCents).toBe(6900);
  });

  it('TC-84 / TC-68 / RX-03 — échec après le 3e transfert : ancienne grille vendue, état FAILED, aucun dégel automatique', async () => {
    await bootstrap();
    const r = await publishCodeCatalog({ trigger: 'auto', failBeforeTransfer: 4 }, t.deps);
    expect(r).toMatchObject({ status: 'failed', step: 'transfer' });
    expect((await store.getState(CTX))!.publicationState).toBe('FAILED');
    // Vente : révision ACTIVE (ancienne grille), même si trois clés ont bougé.
    for (const c of CATALOG_COUPLES) {
      await expect(resolveCurrentPrice(c.planCode, c.billingPeriod, { forPayment: true }, t.deps)).resolves.toMatchObject({ unitAmountCents: { standard: { monthly: 290, yearly: 2900 }, premium: { monthly: 590, yearly: 5900 }, premium_duo: { monthly: 890, yearly: 8900 } }[c.planCode][c.billingPeriod] });
    }
    expect(buildPublicCatalog(await store.getState(CTX), new Date('2026-10-10T10:00:10Z')).offers.map((o) => o.unit_amount_cents)).toEqual([290, 2900, 590, 5900, 890, 8900]);
    // Pas de relance automatique (LK-27), pas de nouvelle publication sans reprise.
    expect(shouldAutoPublish(await store.getState(CTX), manifestRevision(), new Date('2026-12-01'))).toMatchObject({ publish: false, reason: 'PREVIOUS_FAILURE' });
    expect((await publishCodeCatalog({ trigger: 'manual' }, t.deps))).toMatchObject({ status: 'refused', reason: 'PREVIOUS_FAILURE' });
    expect(t.anomalies.some((a) => a.fingerprint.endsWith(':publication'))).toBe(true);
  });

  it('EX-014 / TC-72 — reprise après échec : reprend au dernier point, sans recréer de Price', async () => {
    await bootstrap();
    await publishCodeCatalog({ trigger: 'auto', failBeforeTransfer: 4 }, t.deps);
    const created = fs.calls.filter((c) => c === 'prices.create').length;
    expect(created).toBe(6);
    const r = await publishCodeCatalog({ trigger: 'resume' }, t.deps);
    expect(r.status).toBe('published');
    expect(fs.calls.filter((c) => c === 'prices.create').length).toBe(6);
    expect((await resolveCurrentPrice('premium_duo', 'yearly', {}, t.deps)).unitAmountCents).toBe(9900);
  });

  it('LK-99 — abandon après échec : clés COMPENSÉES vers la révision active, publication automatique suspendue', async () => {
    await bootstrap();
    await publishCodeCatalog({ trigger: 'auto', failBeforeTransfer: 3 }, t.deps);
    const r = await abandonPublication({ actor: 'admin:1' }, t.deps);
    expect(r).toMatchObject({ status: 'abandoned', restored: ['verebona_standard_monthly', 'verebona_standard_yearly'] });
    expect(fs.prices.get('p_std_m')!.lookup_key).toBe('verebona_standard_monthly');
    const st = await store.getState(CTX);
    expect(st!.publicationState).toBe('ACTIVE');
    await store.setCandidate(CTX, manifestRevision(), new Date('2026-01-01'));
    await store.setBackfillCompleted(CTX, new Date());
    expect(shouldAutoPublish(await store.getState(CTX), manifestRevision(), new Date('2026-12-01'))).toMatchObject({ publish: false });
  });

  it('RX-04 / LK-27 — deux publications concurrentes : une seule détient le verrou', async () => {
    await bootstrap();
    t.held.add(`stripe-catalog-publication:${CTX}`);
    expect(await publishCodeCatalog({ trigger: 'manual' }, t.deps)).toEqual({ status: 'refused', reason: 'LOCKED' });
  });

  it('LK-88 — écritures Stripe refusées sans mode attendu explicite', async () => {
    await bootstrap();
    const d2 = { ...t.deps, env: {} as NodeJS.ProcessEnv };
    expect(await publishCodeCatalog({ trigger: 'manual' }, d2)).toEqual({ status: 'refused', reason: 'EXPECTED_MODE_MISSING' });
  });

  it('TC-75 / TC-74 / RX-17 — retour arrière commercial : anciennes clés, registre conservé, aucun abonnement touché', async () => {
    await bootstrap();
    await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    const newStd = (await resolveCurrentPrice('standard', 'monthly', {}, t.deps)).priceId;
    const r = await rollbackCatalog({ actor: 'admin:1', reason: 'test' }, t.deps);
    expect(r.status).toBe('rolled_back');
    expect((await resolveCurrentPrice('standard', 'monthly', {}, t.deps))).toMatchObject({ priceId: 'p_std_m', unitAmountCents: 290 });
    expect(fs.prices.get('p_std_m')!.lookup_key).toBe('verebona_standard_monthly');
    // Le prix vendu au nouveau tarif reste connu (souscriptions conclues intactes).
    expect(await store.findPriceVersion(CTX, newStd)).toMatchObject({ unitAmountCents: 390 });
    expect(fs.calls.some((c) => c.startsWith('subscriptions'))).toBe(false);
  });

  it('EX-006 / LK-97 / D3 — publication automatique : jamais avant reprise terminée et 20 min de code homogène', async () => {
    await bootstrap();
    const rev = manifestRevision();
    let st = await store.getState(CTX);
    expect(shouldAutoPublish(st, rev, new Date())).toMatchObject({ publish: false, reason: 'BACKFILL_PENDING' });
    await store.setBackfillCompleted(CTX, new Date());
    await store.setCandidate(CTX, rev, new Date('2026-10-10T10:00:00Z'));
    st = await store.getState(CTX);
    expect(shouldAutoPublish(st, rev, new Date('2026-10-10T10:05:00Z'))).toMatchObject({ publish: false, reason: 'WAITING_INSTANCES' });
    expect(shouldAutoPublish(st, rev, new Date(new Date('2026-10-10T10:00:00Z').getTime() + AUTO_PUBLISH_DELAY_MS))).toEqual({ publish: true, reason: 'OK' });
  });
});

// ─── Registre historique (§7.4, TC-15 à TC-20) ───────────────────────────────

describe('reconnaissance historique', () => {
  function hdeps(prices: Stripe.Price[], approved = [{ planCode: 'standard' as const, stripeProductId: 'prod_standard', role: 'sale' as const, source: 't' }], env = {} as NodeJS.ProcessEnv): HistoryDeps & { s: ReturnType<typeof memoryStore>; f: ReturnType<typeof fakeStripe> } {
    const s = memoryStore();
    s.products.set(CTX, approved);
    const f = fakeStripe(prices, PRODUCTS);
    return { s, f, store: s, stripe: () => f.client, context: () => ({ catalogContext: CTX, mode: 'test' }), env };
  }

  it('TC-17 / TC-15 — ancien prix sans clé, INACTIF, sous produit approuvé (29 €) : reconnu et inscrit', async () => {
    const d = hdeps([price({ id: 'p_old', amount: 2900, interval: 'year', product: 'prod_standard', active: false, key: null })]);
    const r = await resolveHistoricalPrice('p_old', {}, d);
    expect(r).toMatchObject({ status: 'recognized', planCode: 'standard', billingPeriod: 'yearly', unitAmountCents: 2900, source: 'stripe' });
    expect(await d.s.findPriceVersion(CTX, 'p_old')).toMatchObject({ logicalLookupKey: 'verebona_standard_yearly', observedLookupKey: null });
    // Deuxième lecture : registre, aucun appel Stripe.
    d.f.calls.length = 0;
    expect((await resolveHistoricalPrice('p_old', {}, d))).toMatchObject({ source: 'registry' });
    expect(d.f.calls).toEqual([]);
  });

  it('TC-16 — prix legacy 19 € (variable historique) : reconnu, produit approuvé pour l’historique, sans dépendre ensuite de la variable', async () => {
    const d = hdeps([price({ id: 'p_legacy', amount: 1900, interval: 'year', product: 'prod_legacy_std', key: null })], [], { STRIPE_PRICE_STANDARD: 'p_legacy' } as unknown as NodeJS.ProcessEnv);
    expect(await resolveHistoricalPrice('p_legacy', {}, d)).toMatchObject({ status: 'recognized', planCode: 'standard', source: 'legacy-env' });
    expect(await d.s.listApprovedProducts(CTX)).toEqual([expect.objectContaining({ stripeProductId: 'prod_legacy_std', role: 'historical' })]);
    const sans = { ...d, env: {} as NodeJS.ProcessEnv };
    expect(await resolveHistoricalPrice('p_legacy', {}, sans)).toMatchObject({ status: 'recognized', source: 'registry' });
  });

  it('TC-18 — nouveau prix valide absent du registre mais sous produit approuvé : récupéré et inscrit', async () => {
    const d = hdeps([price({ id: 'p_new', amount: 390, product: 'prod_standard' })]);
    expect(await resolveHistoricalPrice('p_new', { source: 'webhook' }, d)).toMatchObject({ status: 'recognized', planCode: 'standard', billingPeriod: 'monthly' });
    expect(await d.s.findPriceVersion(CTX, 'p_new')).toMatchObject({ source: 'webhook' });
  });

  it('TC-19 — prix d’un autre produit au même montant : jamais assimilé à une offre Verebona', async () => {
    const d = hdeps([price({ id: 'p_autre', amount: 390, product: 'prod_autre_service' })]);
    expect(await resolveHistoricalPrice('p_autre', {}, d)).toEqual({ status: 'unknown', priceId: 'p_autre', reason: 'PRODUCT_NOT_APPROVED' });
  });

  it('TC-20 — prix inconnu et Stripe indisponible : `unavailable` (rejouable), jamais un succès', async () => {
    const d = hdeps([]);
    d.f.failOn.retrieve = true;
    expect(await resolveHistoricalPrice('p_x', {}, d)).toMatchObject({ status: 'unavailable' });
  });

  it('TC-73 — sans aucune variable de prix : reconnaissance par registre / produit approuvé seulement', async () => {
    const d = hdeps([price({ id: 'p_z', amount: 690, product: 'prod_standard' })], undefined, {} as NodeJS.ProcessEnv);
    expect((await resolveHistoricalPrice('p_z', {}, d)).status).toBe('recognized');
  });

  it('classement pur : mode, cadence, métadonnées contradictoires', () => {
    const approved = [{ planCode: 'premium' as const, stripeProductId: 'prod_premium' }];
    expect(classifyFetchedPrice(price({ id: 'a', product: 'prod_premium', livemode: true }), approved, { mode: 'test' })).toMatchObject({ ok: false, reason: 'WRONG_MODE' });
    expect(classifyFetchedPrice(price({ id: 'a', product: 'prod_premium', recurring: { interval: 'week', interval_count: 1 } as Stripe.Price.Recurring }), approved, { mode: 'test' })).toMatchObject({ ok: false, reason: 'UNSUPPORTED_INTERVAL' });
    expect(classifyFetchedPrice(price({ id: 'a', product: 'prod_premium', metadata: { verebona_plan: 'standard' } }), approved, { mode: 'test' })).toMatchObject({ ok: false, reason: 'METADATA_CONFLICT' });
  });
});

// ─── Revalorisation (règles pures, §25.3) ────────────────────────────────────

describe('revalorisation des abonnements existants (règles)', () => {
  const sub = (o: Partial<Stripe.Subscription> = {}, quantity = 1) => ({
    status: 'active', cancel_at_period_end: false, schedule: null,
    items: { data: [{ id: 'si_1', quantity, price: { id: 'p_old' } }] }, ...o,
  }) as unknown as Stripe.Subscription;
  const ctx = { withdrawn: false, userScheduledChange: false };

  it('TC-87 / RX-10 / RX-11 / EX-023 — statuts : annulé exclu, résiliation à échéance / impayé / suspendu / essai différés', () => {
    expect(evaluateEligibility(sub(), ctx)).toEqual({ status: 'eligible' });
    expect(evaluateEligibility(sub({ status: 'canceled' }), ctx)).toMatchObject({ status: 'excluded', migration: 'canceled' });
    expect(evaluateEligibility(sub({ cancel_at_period_end: true }), ctx)).toMatchObject({ status: 'deferred', reason: 'CANCEL_AT_PERIOD_END' });
    for (const s of ['past_due', 'unpaid', 'paused', 'incomplete'] as const) expect(evaluateEligibility(sub({ status: s }), ctx)).toMatchObject({ status: 'deferred' });
    expect(evaluateEligibility(sub({ status: 'trialing' }), ctx)).toMatchObject({ status: 'deferred', reason: 'TRIALING' });
    expect(evaluateEligibility(sub(), { ...ctx, withdrawn: true })).toMatchObject({ status: 'excluded', reason: 'WITHDRAWN' });
  });

  it('RX-12 / EX-025 — changement programmé par l’utilisateur : différé (intention et prix acceptés préservés) ; échéancier étranger : bloqué', () => {
    expect(evaluateEligibility(sub({ schedule: 'sched' as never }), { ...ctx, userScheduledChange: true })).toMatchObject({ status: 'deferred', reason: 'USER_SCHEDULED_CHANGE' });
    expect(evaluateEligibility(sub({ schedule: 'sched' as never }), ctx)).toMatchObject({ status: 'excluded', reason: 'FOREIGN_SCHEDULE', migration: 'blocked' });
  });

  it('LK-73 / RX-08 — plusieurs items ou quantité ≠ 1 : exception ; Duo quantité 1 éligible', () => {
    expect(evaluateEligibility(sub({}, 2), ctx)).toMatchObject({ status: 'excluded', reason: 'QUANTITY_NOT_ONE' });
    expect(evaluateEligibility(sub({ items: { data: [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 1 }] } as never }), ctx)).toMatchObject({ reason: 'MULTIPLE_ITEMS' });
  });

  it('TC-90 / RX-20 / RX-09 / EX-019 — information non prouvée, préavis en cours, échéance trop proche : rien n’est planifié', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const renewal = new Date('2026-12-01T00:00:00Z');
    expect(revaluationTiming(renewal, null, now)).toEqual({ ready: false, reason: 'NOTICE_NOT_PROVEN' });
    expect(revaluationTiming(renewal, new Date('2026-12-15'), now)).toEqual({ ready: false, reason: 'NOTICE_PERIOD_RUNNING' });
    expect(revaluationTiming(new Date(now.getTime() + RENEWAL_SAFETY_MS - 1), new Date('2026-10-01'), now)).toEqual({ ready: false, reason: 'RENEWAL_TOO_CLOSE' });
    expect(revaluationTiming(renewal, new Date('2026-11-09'), now)).toEqual({ ready: true, reason: 'OK' });
  });

  it('EX-020 / TC-86 / RX-14 / EX-026 — phases : période payée inchangée, nouveau prix à l’échéance, sans prorata, remise par identifiant', () => {
    const phases = buildRevaluationPhases({
      start_date: 100, end_date: 200, items: [{ price: 'p_old_y', quantity: 1, tax_rates: [] }],
      discounts: [{ discount: 'di_10pct', coupon: 'co_10', promotion_code: null }], default_tax_rates: [], metadata: {},
    } as never, 'p_new_y', 'yearly', { verebona_revaluation: 'cv_1', verebona_migration_id: '7' });
    expect(phases[0]).toMatchObject({ items: [{ price: 'p_old_y', quantity: 1 }], start_date: 100, end_date: 200, proration_behavior: 'none', discounts: [{ discount: 'di_10pct' }] });
    expect(phases[1]).toMatchObject({ items: [{ price: 'p_new_y', quantity: 1 }], duration: { interval: 'year', interval_count: 1 }, proration_behavior: 'none', discounts: [{ discount: 'di_10pct' }] });
  });

  it('EX-016 — seuls les couples dont le MONTANT change entrent dans la campagne', () => {
    const snap = (amounts: number[]) => ({
      version: 'v', verifiedAt: '', source: 'sync' as const, unavailable: {},
      entries: Object.fromEntries(CATALOG_COUPLES.map((c, i) => [`${c.planCode}:${c.billingPeriod}`, { priceId: `p${i}_${amounts[i]}`, unitAmountCents: amounts[i] } as never])),
    });
    const changed = changedCouples(snap([290, 2900, 590, 5900, 890, 8900]), snap([390, 2900, 690, 5900, 890, 8900]));
    expect([...changed.keys()]).toEqual(['standard:monthly', 'premium:monthly']);
  });
});

// ─── Portail et webhooks ─────────────────────────────────────────────────────

describe('portail de montée en gamme et webhooks', () => {
  it('LK-48 / LK-49 / LK-50 — produits autorisés = révision active (+ fenêtre de bascule), empreinte déterministe', () => {
    const snapshot = { version: 'v', verifiedAt: '', unavailable: {}, source: 'sync' as const, entries: {
      'standard:monthly': { productId: 'prod_s', priceId: 'p2' }, 'standard:yearly': { productId: 'prod_s', priceId: 'p1' }, 'premium:monthly': { productId: 'prod_p', priceId: 'p3' },
    } as never };
    expect(portalProductsFor(snapshot)).toEqual([{ product: 'prod_p', prices: ['p3'] }, { product: 'prod_s', prices: ['p1', 'p2'] }]);
    expect(portalProductsFor(snapshot, [{ productId: 'prod_s', priceId: 'p_old' }])[1].prices).toContain('p_old');
    expect(portalFingerprint('c', 'bpc', portalProductsFor(snapshot))).toBe(portalFingerprint('c', 'bpc', portalProductsFor(snapshot)));
    expect(acceptedPrices({ features: { subscription_update: { products: [{ product: 'x', prices: ['b', 'a'] }] } } } as never)).toEqual(['a', 'b']);
  });

  it('TC-41 — publication : portail existant / imposé réaligné, prix effectivement acceptés relus', async () => {
    await bootstrap();
    await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    const conf = [...fs.portal.values()][0];
    const st = await store.getState(CTX);
    const expected = Object.values(st!.activeSnapshot!.entries).map((e) => e!.priceId).sort();
    expect(acceptedPrices(conf)).toEqual(expected);
    expect(conf.features.subscription_update.proration_behavior).toBe('always_invoice');
  });

  it('TC-23 / LK-70 — prise en charge atomique d’un événement : une seule exécution simultanée', async () => {
    const seen = new Map<string, { processed: boolean; claimed: boolean }>();
    const exec = {
      unsafe: async (q: string, pp?: never[]) => {
        const p = (pp ?? []) as unknown[];
        if (q.startsWith('INSERT INTO stripe_webhook_logs')) {
          const cur = seen.get(p[1] as string);
          if (!cur) { seen.set(p[1] as string, { processed: false, claimed: true }); return [{ id: 1 }]; }
          return [];
        }
        return [{ processed: seen.get(p[0] as string)?.processed ?? false }];
      },
    };
    expect(await claimWebhookEvent({ id: 'evt_1', type: 'invoice.paid' }, '{}', exec)).toBe('CLAIMED');
    expect(await claimWebhookEvent({ id: 'evt_1', type: 'invoice.paid' }, '{}', exec)).toBe('IN_PROGRESS');
    seen.get('evt_1')!.processed = true;
    expect(await claimWebhookEvent({ id: 'evt_1', type: 'invoice.paid' }, '{}', exec)).toBe('ALREADY_PROCESSED');
  });

  it('TC-24 — invoice.paid et invoice.payment_succeeded d’une même facture : effets métier une seule fois', async () => {
    const done = new Set<string>();
    const exec = { unsafe: async (_q: string, pp?: never[]) => { const p = (pp ?? []) as unknown[]; const k = `${p[0]}|${p[1]}`; if (done.has(k)) return []; done.add(k); return [{ stripe_invoice_id: p[0] }]; } };
    expect(await claimInvoiceEffect('in_1', 'payment_succeeded', exec)).toBe(true);
    expect(await claimInvoiceEffect('in_1', 'payment_succeeded', exec)).toBe(false);
  });

  it('version globale = empreinte des révisions disponibles', () => {
    expect(catalogVersionOf({})).toMatch(/^cv_/);
  });
});
