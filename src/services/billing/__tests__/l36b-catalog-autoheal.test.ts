/**
 * Lot 36B — « Tarif indisponible » partout sur la vitrine après le lot 35.
 *
 * Comptes Stripe RÉALISTES (helpers/realistic-stripe : unicité des
 * lookup_key même sur un prix archivé, filtres réels de `prices.list`,
 * produits sans métadonnée, clé restreinte), exécutés de bout en bout par les
 * VRAIES tâches planifiées (`stripe-catalog-sync`, `stripe-catalog-publish`)
 * jusqu'au catalogue PUBLIC lu par la vitrine et l'application :
 *   (a) prix de l'ancien seed (clés, métadonnée produit `verebona_<offre>`,
 *       taxes `unspecified`), avec / sans variables V2, prix archivés ;
 *   (b) prix créés à la main, sans clé ni métadonnée, seules les variables
 *       V1 / V2 pointent dessus ; clé restreinte ;
 *   (c) aucune variable ;
 *   (d) STRIPE_EXPECTED_MODE absente.
 * La reprise historique est simulée BLOQUÉE (abonnés de test à des prix non
 * rapprochables) : c'est elle qui empêchait toute publication au lot 35.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

vi.mock('@/db', () => ({ pgClient: { unsafe: async () => [] }, db: {} }));
const campaigns: Array<{ previous: unknown; next: unknown }> = [];
vi.mock('../price-revaluation.service', async (orig) => {
  const real = await orig<typeof import('../price-revaluation.service')>();
  return {
    ...real,
    createRevaluationCampaign: async (input: { previous: unknown; next: unknown }) => { campaigns.push(input); return { inventoried: 0, planned: 0, deferred: 0, excluded: 0, skippedSamePrice: 0 }; },
    cancelCampaign: async () => 0,
  };
});
// Reprise historique qui ne peut pas aboutir (références d'abonnés non rapprochables).
const backfill = vi.fn(async () => ({ references: 4, recognized: 1, unknown: ['price_x'], inconsistent: [], unavailable: [], contractsEnriched: 0, schedulesEnriched: 0, schedulesBlocked: 0, multiItemSubscriptions: [], foreignSubscriptions: 0, blocking: 3, completed: false }));
vi.mock('../price-backfill.service', () => ({ runPriceBackfill: backfill }));

import { CATALOG_COUPLES, planFromMetadataValue } from '@/lib/billing/plan-catalog';
import { explainCoupleReason, explainCatalogReason, COUPLE_REASONS } from '@/lib/billing/catalog-reasons';
import { __setCatalogDepsForTests, forgetCatalogMemory, getPublicCatalog, refreshCatalog, resolveCurrentPrice } from '../price-catalog.service';
import { AUTO_PUBLISH_DELAY_MS, BOOTSTRAP_RETRY_MS, bootstrapDecision, publishCodeCatalog, shouldAutoPublish, abandonPublication } from '../catalog-publication.service';
import { runCatalogPublishTask, runCatalogSyncTask } from '../catalog-tasks';
import { manifestRevision } from '../pricing-manifest';
import { memoryStore, testDeps } from './helpers/fake-stripe-catalog';
import { manualAccount, mkPrice, realisticStripe, seedAccount, v1Env, v2Env, type RealisticOptions } from './helpers/realistic-stripe';

const CTX = 'test:preprod';
const MANIFEST = [390, 3900, 690, 6900, 990, 9900];
const V2 = [290, 2900, 590, 5900, 890, 8900];
// Horloge du test = horloge réelle (le magasin en mémoire date les exécutions avec `new Date()`).
const T0 = new Date();

let store: ReturnType<typeof memoryStore>;
let rs: ReturnType<typeof realisticStripe>;
let t: ReturnType<typeof testDeps>;

function deploy(account: { prices: Stripe.Price[]; products: Stripe.Product[] }, env: Record<string, string> = {}, opts: RealisticOptions = {}, baseEnv: Record<string, string> = { STRIPE_EXPECTED_MODE: 'test' }) {
  store = memoryStore();
  rs = realisticStripe(account.prices, account.products, opts);
  t = testDeps(store, rs.client, { env: { ...baseEnv, ...env } as unknown as NodeJS.ProcessEnv });
  t.setNow(T0);
  __setCatalogDepsForTests(t.deps);
}
const at = (minutes: number) => t.setNow(new Date(T0.getTime() + minutes * 60_000));
const tick = () => runCatalogSyncTask({ trigger: 'schedule', deadline: Date.now() + 60_000 });
const pub = async () => { forgetCatalogMemory(); return getPublicCatalog(t.deps); };
const amounts = (p: Awaited<ReturnType<typeof pub>>) => p.offers.map((o) => o.unit_amount_cents);
const creates = () => rs.calls.filter((c) => c === 'prices.create').length;
const noIds = (p: unknown) => expect(JSON.stringify(p)).not.toMatch(/(price|prod)_(seed|man|new|v1|usd|supprime)|acct_|sk_|cus_|sub_/);

async function expectManifestOk() {
  const p = await pub();
  expect(p).toMatchObject({ status: 'ok', purchasable: true, reason: null, unavailable: [] });
  expect(p.offers).toHaveLength(6);
  expect(amounts(p)).toEqual(MANIFEST);
  noIds(p);
  // Checkout relit le prix chez Stripe : TTC `inclusive`, sous un produit approuvé.
  for (const c of CATALOG_COUPLES) {
    const r = await resolveCurrentPrice(c.planCode, c.billingPeriod, { forPayment: true }, t.deps);
    expect(r).toMatchObject({ taxBehavior: 'inclusive', lookupKey: c.lookupKey });
    expect(rs.prices.get(r.priceId)!.lookup_key).toBe(c.lookupKey);
  }
  expect((await store.getState(CTX))!.publishedManifestRevision).toBe(manifestRevision());
  return p;
}

beforeEach(() => {
  campaigns.length = 0;
  backfill.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ─── (a) Ancien seed ─────────────────────────────────────────────────────────

describe('(a) prix créés par l’ancien seed', () => {
  it.each([
    ['sans variable', {}],
    ['avec variables V2 vers les prix du seed', v2Env('seed')],
  ])('AC-a — %s : catalogue public « ok », 6 offres (grille réellement vendue), sans publication prématurée', async (_l, env) => {
    deploy(seedAccount(), env);
    await tick();
    const p = await pub();
    expect(p).toMatchObject({ status: 'ok', reason: null });
    expect(amounts(p)).toEqual(V2);
    noIds(p);
    // Convention du seed reconnue : métadonnée produit `verebona_<offre>`.
    expect(store.products.get(CTX)!.map((x) => [x.planCode, x.stripeProductId, x.role])).toEqual([
      ['standard', 'prod_seed_std', 'sale'], ['premium', 'prod_seed_pre', 'sale'], ['premium_duo', 'prod_seed_duo', 'sale'],
    ]);
    expect(creates()).toBe(0);
    // Grille complète vendue : la règle normale (reprise historique, 20 min) s'applique.
    expect(shouldAutoPublish(await store.getState(CTX), manifestRevision(), new Date(T0.getTime() + 60 * 60_000))).toMatchObject({ publish: false, reason: 'BACKFILL_PENDING' });
  });

  it('AC-a — puis la grille du code est publiée sous les MÊMES produits (reprise terminée + 20 min)', async () => {
    deploy(seedAccount());
    await tick();
    await store.setBackfillCompleted(CTX, new Date());
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    expect((await runCatalogPublishTask()).note).toMatch(/publication : published/);
    await expectManifestOk();
    expect(new Set([...rs.prices.values()].filter((x) => x.id.startsWith('price_new_')).map((x) => x.product))).toEqual(new Set(['prod_seed_std', 'prod_seed_pre', 'prod_seed_duo']));
    // Anciens prix : actifs, sans clé, toujours au registre (abonnés existants intacts).
    expect(rs.prices.get('price_seed_std_m')).toMatchObject({ active: true, lookup_key: null });
    expect(await store.findPriceVersion(CTX, 'price_seed_std_m')).toMatchObject({ unitAmountCents: 290 });
  });

  it('AC-a — prix du seed ARCHIVÉS mais variables V2 vers de nouveaux prix : clés transférées depuis les archivés', async () => {
    const seed = seedAccount({ archived: true });
    const man = manualAccount();
    deploy({ prices: [...seed.prices, ...man.prices], products: [...seed.products, ...man.products] }, v2Env('man'));
    await tick();
    const p = await pub();
    expect(p).toMatchObject({ status: 'ok', reason: null });
    expect(amounts(p)).toEqual(V2);
    expect(rs.prices.get('price_man_std_m')!.lookup_key).toBe('verebona_standard_monthly');
    expect(rs.prices.get('price_seed_std_m')!.lookup_key).toBeNull();
  });

  it('AC-a — prix du seed ARCHIVÉS, aucune variable : raison KEY_ON_ARCHIVED_PRICE puis première publication immédiate', async () => {
    deploy(seedAccount({ archived: true }));
    await refreshCatalog({ source: 'test' }, t.deps);
    const before = await pub();
    expect(before).toMatchObject({ status: 'unavailable', reason: 'PUBLICATION_PENDING' });
    expect(before.unavailable.map((u) => u.reason)).toEqual(Array(6).fill('KEY_ON_ARCHIVED_PRICE'));
    await tick();
    await expectManifestOk();
    // LK-03 : produits existants du seed réutilisés (recherche par métadonnée), aucun produit créé.
    expect(rs.calls).not.toContain('products.create');
  });
});

// ─── (b) Prix créés à la main ────────────────────────────────────────────────

describe('(b) prix créés à la main (ni clé ni métadonnée)', () => {
  it('AC-b — variables V2 : clés initialisées, produits approuvés par la preuve de configuration, « ok »', async () => {
    deploy(manualAccount(), v2Env('man'));
    await tick();
    const p = await pub();
    expect(p).toMatchObject({ status: 'ok', reason: null });
    expect(amounts(p)).toEqual(V2);
    expect(store.products.get(CTX)!.every((x) => x.source === 'bootstrap:legacy-env')).toBe(true);
    expect(creates()).toBe(0);
  });

  it('AC-b — variables V1 seulement : 6 × KEY_MISSING (cause lot 35) puis première publication SANS attendre la reprise', async () => {
    deploy(manualAccount({ legacyAnnual: true }), v1Env());
    await refreshCatalog({ source: 'test' }, t.deps);
    const before = await pub();
    expect(before).toMatchObject({ status: 'unavailable', offers: [], reason: 'PUBLICATION_PENDING' });
    expect(before.unavailable.map((u) => u.reason)).toEqual(Array(6).fill('KEY_MISSING'));
    noIds(before);
    // Lot 35 : publication suspendue à la reprise historique — ici bloquée.
    expect(bootstrapDecision(await store.getState(CTX), manifestRevision(), T0)).toEqual({ publish: true, reason: 'BOOTSTRAP', trigger: 'auto' });
    const note = (await tick()).note!;
    expect(note).toMatch(/première publication : published/);
    expect(note).toMatch(/reprise historique : 3 référence\(s\) bloquante\(s\)/);
    await expectManifestOk();
    // Produits des prix configurés (V1) réutilisés — aucun produit créé (LK-03).
    expect(rs.calls).not.toContain('products.create');
    expect(new Set([...rs.prices.values()].filter((x) => x.id.startsWith('price_new_')).map((x) => x.product))).toEqual(new Set(['prod_man_std', 'prod_man_pre', 'prod_man_duo']));
    // Aucun abonné revalorisé (pas de révision précédente vendue) ; anciens prix intacts.
    expect(campaigns.every((c) => !(c.previous as { entries?: object })?.entries || Object.keys((c.previous as { entries: object }).entries).length === 0)).toBe(true);
    expect(rs.prices.get('price_v1_pre')).toMatchObject({ active: true, unit_amount: 5900 });
    expect((await store.getState(CTX))!.previousSnapshot).toBeNull();
  });

  it('AC-b — clés posées à la main sous des produits non reconnus : PRODUCT_NOT_APPROVED puis publication (produits créés)', async () => {
    deploy(manualAccount({ keys: true }));
    await refreshCatalog({ source: 'test' }, t.deps);
    expect((await pub()).unavailable.map((u) => u.reason)).toEqual(Array(6).fill('PRODUCT_NOT_APPROVED'));
    await tick();
    await expectManifestOk();
    expect(rs.calls.filter((c) => c === 'products.create')).toHaveLength(3);
    // Les prix manuels gardent leur existence (clé transférée, jamais supprimés).
    expect(rs.prices.get('price_man_std_m')).toMatchObject({ active: true, lookup_key: null });
  });

  it('AC-b — clé RESTREINTE sans écriture : raison STRIPE_PERMISSION, échec repris tout seul quand le droit est donné', async () => {
    deploy(manualAccount(), v2Env('man'), { denyWrites: { prices: true } });
    await tick();
    let p = await pub();
    expect(p.status).toBe('unavailable');
    expect(p.reason).toBe('PUBLICATION_FAILED');
    expect(p.unavailable.map((u) => u.reason)).toEqual(Array(6).fill('STRIPE_PERMISSION'));
    expect(explainCoupleReason('STRIPE_PERMISSION')!.hint).toMatch(/Clés API/);
    at(5);
    expect(shouldAutoPublish(await store.getState(CTX), manifestRevision(), new Date(T0.getTime() + 5 * 60_000), new Date(T0))).toMatchObject({ publish: false, reason: 'BOOTSTRAP_RETRY_WAIT' });
    rs.opts.denyWrites = {};
    at(BOOTSTRAP_RETRY_MS / 60_000 + 1);
    await tick();
    p = await pub();
    expect(p.status).toBe('ok');
    expect(amounts(p)).toEqual(MANIFEST);
  });
});

// ─── (c) Aucune variable ─────────────────────────────────────────────────────

describe('(c) aucune variable de prix', () => {
  it.each([
    ['prix manuels sans clé', manualAccount()],
    ['compte Stripe vide', { prices: [] as Stripe.Price[], products: [] as Stripe.Product[] }],
  ])('AC-c — %s : première publication au premier passage de la tâche (≤ 5 min), 6 offres du manifeste', async (_l, account) => {
    deploy(account);
    await tick();
    await expectManifestOk();
    expect(rs.calls.filter((c) => c === 'products.create')).toHaveLength(3);
    // Relance : idempotente (aucun prix ni produit en plus).
    const n = creates();
    at(5);
    await tick();
    await runCatalogPublishTask();
    expect(creates()).toBe(n);
  });

  it('AC-c — échec ponctuel de Stripe pendant la première publication : reprise automatique sans doublon', async () => {
    deploy(manualAccount(), {}, { failOnce: { productsCreate: true } });
    await tick();
    expect((await store.getState(CTX))!.publicationState).toBe('FAILED');
    expect((await pub()).reason).toBe('PUBLICATION_FAILED');
    at(BOOTSTRAP_RETRY_MS / 60_000 + 1);
    expect((await runCatalogPublishTask()).note).toMatch(/published/);
    await expectManifestOk();
    expect(creates()).toBe(6);
  });

  it('AC-c — portail de montée en gamme refusé par Stripe : la première publication aboutit quand même (anomalie)', async () => {
    deploy(manualAccount(), {}, { failOnce: { portal: true } });
    await tick();
    await expectManifestOk();
    expect(t.anomalies.some((a) => a.fingerprint.endsWith(':portal'))).toBe(true);
  });
});

// ─── (d) STRIPE_EXPECTED_MODE absente ────────────────────────────────────────

describe('(d) STRIPE_EXPECTED_MODE absente', () => {
  it('AC-d — mode déduit de NEXT_PUBLIC_APP_ENV=preprod : publication permise, « ok »', async () => {
    deploy(manualAccount(), {}, {}, { NEXT_PUBLIC_APP_ENV: 'preprod' });
    await tick();
    await expectManifestOk();
  });

  it('AC-d — ni STRIPE_EXPECTED_MODE ni NEXT_PUBLIC_APP_ENV : écritures refusées (LK-88), raison exposée, rien de créé', async () => {
    deploy(manualAccount(), {}, {}, {});
    await tick();
    const p = await pub();
    expect(p).toMatchObject({ status: 'unavailable', reason: 'PUBLICATION_PENDING' });
    expect(creates()).toBe(0);
    expect((await publishCodeCatalog({ trigger: 'manual' }, t.deps))).toEqual({ status: 'refused', reason: 'EXPECTED_MODE_MISSING' });
    expect(explainCatalogReason('EXPECTED_MODE_MISSING')!.hint).toMatch(/STRIPE_EXPECTED_MODE/);
  });
});

// ─── Grille partielle, garde-fous et non-régression ─────────────────────────

describe('règles de l’amorçage (non-régression lot 35)', () => {
  it('AC-partiel — 4/6 vendus : pas avant 20 min (instances homogènes), puis 6 offres ; revalorisation des seuls couples vendus', async () => {
    deploy(seedAccount({ only: ['standard', 'premium'] }));
    await tick();
    let p = await pub();
    expect(p.offers).toHaveLength(4);
    expect(p.reason).toBe('PUBLICATION_PENDING');
    expect(p.unavailable).toEqual([
      { plan_code: 'premium_duo', billing_period: 'monthly', reason: 'KEY_MISSING' },
      { plan_code: 'premium_duo', billing_period: 'yearly', reason: 'KEY_MISSING' },
    ]);
    expect(creates()).toBe(0);
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    await tick();
    p = await pub();
    expect(amounts(p)).toEqual(MANIFEST);
    expect(campaigns).toHaveLength(1);
    expect((await store.getState(CTX))!.previousSnapshot).not.toBeNull();
  });

  it('grille complète, déjà publiée, abandonnée ou échec avec grille vendue : aucun amorçage', async () => {
    deploy(seedAccount());
    await tick();
    expect(bootstrapDecision(await store.getState(CTX), manifestRevision(), T0)).toBeNull();
    await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    const st = await store.getState(CTX);
    // Déjà publié une fois : même si les clés disparaissent ensuite, pas de republication automatique.
    expect(bootstrapDecision({ ...st!, activeSnapshot: { ...st!.activeSnapshot!, entries: {} } }, manifestRevision(), T0)).toBeNull();
    expect(bootstrapDecision({ ...st!, publishedManifestRevision: null, activeSnapshot: { ...st!.activeSnapshot!, entries: {} }, publicationError: `ABANDONED:${manifestRevision()}` }, manifestRevision(), T0)).toEqual({ publish: false, reason: 'ABANDONED' });
    const partial = { ...st!, publishedManifestRevision: null, publicationState: 'FAILED' as const, activeSnapshot: { ...st!.activeSnapshot!, entries: { 'standard:monthly': st!.activeSnapshot!.entries['standard:monthly'] } } };
    expect(bootstrapDecision(partial, manifestRevision(), T0)).toBeNull();
    expect(shouldAutoPublish(partial, manifestRevision(), T0)).toMatchObject({ publish: false, reason: 'PREVIOUS_FAILURE' });
  });

  it('abandon après un amorçage en échec : publication automatique suspendue pour ce manifeste', async () => {
    deploy(manualAccount(), {}, { failOnce: { productsCreate: true } });
    await tick();
    expect((await abandonPublication({ actor: 'admin:1' }, t.deps)).status).toBe('abandoned');
    at(60);
    await tick();
    expect(creates()).toBe(0);
    expect((await pub()).status).toBe('unavailable');
  });

  it('une clé portée par un prix ACTIF n’est jamais volée par l’initialisation (raison KEY_ON_INVALID_PRICE)', async () => {
    const man = manualAccount();
    // Prix actif en USD portant la clé mensuelle Standard.
    man.prices.push(mkPrice({ id: 'price_usd', product: 'prod_man_std', amount: 300, interval: 'month', key: 'verebona_standard_monthly', currency: 'usd' }));
    deploy(man, v2Env('man'));
    await refreshCatalog({ source: 'test' }, t.deps);
    const p = await pub();
    expect(p.unavailable).toEqual([{ plan_code: 'standard', billing_period: 'monthly', reason: 'KEY_ON_INVALID_PRICE' }]);
    expect(rs.prices.get('price_usd')!.lookup_key).toBe('verebona_standard_monthly');
  });

  it('variable V2 vers un prix inexistant / porteur d’une autre clé : raisons distinctes', async () => {
    const man = manualAccount();
    man.prices = man.prices.map((x) => (x.id === 'price_man_pre_m' ? { ...x, lookup_key: 'premium_monthly_manuel' } : x));
    deploy(man, { ...v2Env('man'), STRIPE_PRICE_STANDARD_YEARLY: 'price_supprime' });
    await refreshCatalog({ source: 'test' }, t.deps);
    const reasons = Object.fromEntries((await pub()).unavailable.map((u) => [`${u.plan_code}:${u.billing_period}`, u.reason]));
    expect(reasons).toEqual({ 'standard:yearly': 'LEGACY_PRICE_NOT_FOUND', 'premium:monthly': 'LEGACY_PRICE_OTHER_KEY' });
  });

  it('chaque raison exposée a un libellé et une correction (bouton BO ou réglage)', () => {
    for (const [code, e] of Object.entries(COUPLE_REASONS)) {
      expect(e.label.length, code).toBeGreaterThan(5);
      expect(Boolean(e.action) || Boolean(e.hint) || code === 'NO_ACTIVE_REVISION', code).toBe(true);
    }
    for (const code of ['STRIPE_NOT_CONFIGURED', 'NOT_INITIALIZED', 'SYNC_FAILED', 'PUBLICATION_PENDING', 'PUBLICATION_IN_PROGRESS', 'PUBLICATION_FAILED', 'PRICES_UNAVAILABLE']) {
      expect(explainCatalogReason(code), code).not.toBeNull();
    }
  });

  it('convention de métadonnée : seed (`verebona_<offre>`), prix (`<offre>`) et variantes d’écriture', () => {
    expect(planFromMetadataValue('verebona_standard')).toBe('standard');
    expect(planFromMetadataValue('premium')).toBe('premium');
    expect(planFromMetadataValue('verebona_premium_duo')).toBe('premium_duo');
    expect(planFromMetadataValue('Verebona-Premium-Duo')).toBe('premium_duo');
    expect(planFromMetadataValue('duo')).toBe('premium_duo');
    expect(planFromMetadataValue('premium pro')).toBeNull();
  });

  it('reprise historique : seuls les abonnements EN COURS bloquent', async () => {
    const { CURRENT_STRIPE_STATUSES } = await vi.importActual<typeof import('../price-backfill.service')>('../price-backfill.service');
    expect(CURRENT_STRIPE_STATUSES.has('active')).toBe(true);
    expect(CURRENT_STRIPE_STATUSES.has('past_due')).toBe(true);
    expect(CURRENT_STRIPE_STATUSES.has('canceled')).toBe(false);
    expect(CURRENT_STRIPE_STATUSES.has('incomplete_expired')).toBe(false);
  });

  it('clé Stripe absente : raison STRIPE_NOT_CONFIGURED (aucune lecture Stripe)', async () => {
    deploy(manualAccount());
    __setCatalogDepsForTests({ ...t.deps, context: () => ({ mode: null, appEnv: 'preprod', catalogContext: 'nokey:preprod' }) });
    const p = await getPublicCatalog();
    expect(p).toMatchObject({ status: 'unavailable', reason: 'STRIPE_NOT_CONFIGURED' });
    expect(rs.calls).toEqual([]);
  });
});
