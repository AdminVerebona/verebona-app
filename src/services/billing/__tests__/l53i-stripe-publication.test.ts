/**
 * Lot 53I — BUG P1 Stripe : publication tarifaire bloquée en préproduction
 * (PORTAL_MISMATCH « prix acceptés ∅ », PORTAL_RESTORE_FAILED, rattrapage
 * FAILED après 1/5, 503 PORTAL_UPDATING, « Publier la grille du code » →
 * PREVIOUS_FAILURE).
 *
 * CAUSE RACINE : `features.subscription_update.products` est un champ
 * INCLUDABLE de l'API Stripe (version 2025-08-27.basil) — il n'est renvoyé
 * par retrieve / update / create / list que s'il est demandé par
 * `expand: ['features.subscription_update.products']`. Le code relisait la
 * configuration SANS expansion puis assimilait la propriété absente à une
 * liste vide (`?? []`) : toute vérification échouait (« ∅ »), y compris celle
 * de la restauration, et le clic « monter en gamme » restait bloqué.
 *
 * Doublure Stripe FIDÈLE (helpers/realistic-stripe) : `products` omis des
 * réponses sans expansion ; l'objet stocké (`rs.portal`) représente l'état
 * réel chez Stripe. Tests nommés STRIPE-P1-xx (critères du ticket §3 à §6).
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
    listCampaign: async () => ({ revisionId: null, counts: {}, rows: [] }),
  };
});
vi.mock('../price-backfill.service', () => ({ runPriceBackfill: vi.fn(async () => ({ completed: true, blocking: 0 })) }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOG_COUPLES, coupleKey } from '@/lib/billing/plan-catalog';
import { recoveryDisplay, RECOVERY_PHASE_LABELS } from '@/lib/billing/catalog-recovery-display';
import { explainCatalogReason } from '@/lib/billing/catalog-reasons';
import {
  __setCatalogDepsForTests, assertDisplayedRevision, forgetCatalogMemory, getPublicCatalog, memoryTtlMs, presentationTtlSeconds, resolveCurrentPrice,
} from '../price-catalog.service';
import { AUTO_PUBLISH_DELAY_MS, publishCodeCatalog } from '../catalog-publication.service';
import { runCatalogPublishTask, runCatalogSyncTask } from '../catalog-tasks';
import {
  EXPECTED_V4_GRID, PORTAL_INTERVAL_RECOVERY, PORTAL_PRODUCTS_RECOVERY, RECOVERY_MAX_ATTEMPTS, liveGuard, recoveryDelayMs, recoveryTargetsFor,
  runCatalogRecoveries, runPortalProductsRecovery,
} from '../catalog-recovery.service';
import {
  PORTAL_PRODUCTS_EXPAND, acceptedProductsOf, capturePortalConfiguration, completeGridIssues, ensureUpgradePortalConfiguration, portalPriceRefs,
  portalProductsFor, readPortalProducts, restorePortalConfiguration, syncUpgradePortal,
} from '../portal-configuration.service';
import { getCatalogDiagnostic } from '../catalog-diagnostic.service';
import { manifestRevision } from '../pricing-manifest';
import { memoryStore, testDeps } from './helpers/fake-stripe-catalog';
import { realisticStripe, seedAccount, PRODUCTS_EXPAND_PATH, type RealisticOptions } from './helpers/realistic-stripe';

const CTX = 'test:preprod';
const ACCT = 'acct_1SX8QQL7bbQ8HKBX';
const MANIFEST = [390, 3900, 690, 6900, 990, 9900];
const T0 = new Date('2026-10-13T08:00:00Z');

let store: ReturnType<typeof memoryStore>;
let rs: ReturnType<typeof realisticStripe>;
let t: ReturnType<typeof testDeps>;

function deploy(account: { prices: Stripe.Price[]; products: Stripe.Product[] }, env: Record<string, string> = {}, opts: RealisticOptions = {}) {
  store = memoryStore();
  rs = realisticStripe(account.prices, account.products, { accountId: ACCT, ...opts });
  t = testDeps(store, rs.client, { env: { STRIPE_EXPECTED_MODE: 'test', ...env } as unknown as NodeJS.ProcessEnv });
  t.setNow(T0);
  __setCatalogDepsForTests(t.deps);
}
const at = (minutes: number) => t.setNow(new Date(T0.getTime() + minutes * 60_000));
const tick = () => runCatalogSyncTask({ trigger: 'schedule', deadline: Date.now() + 60_000 });
const isNew = (products: Array<{ prices: string[] }>) => products.some((p) => p.prices.some((id) => id.startsWith('price_new_')));
const newPrices = () => [...rs.prices.values()].filter((p) => p.id.startsWith('price_new_'));
const portalConf = () => [...rs.portal.values()][0];
const storedPrices = () => (portalConf().features.subscription_update.products ?? []).flatMap((p) => p.prices).sort();

/**
 * Incident initial (lot 49A) tel qu'en préprod : grille V2 vendue, six
 * nouveaux Price créés, clés transférées, portail refusé sur l'union →
 * FAILED « unique billing intervals ».
 */
async function intervalsIncident(opts: RealisticOptions = {}) {
  deploy(seedAccount(), {}, opts);
  await tick();
  await store.setBackfillCompleted(CTX, new Date());
  at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
  rs.opts.portalFail = (_n, products) => (isNew(products) ? 'intervals' : null);
  expect((await runCatalogPublishTask()).error).toMatch(/publication en échec/);
  rs.opts.portalFail = undefined;
  store.states.get(CTX)!.publicationError = 'unexpected: For each product, its price must have unique billing intervals.';
  expect(newPrices()).toHaveLength(6);
}

beforeEach(() => {
  campaigns.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('STRIPE-P1 — reproduction de la séquence préprod', () => {
  it('STRIPE-P1-01 — l’API omet `subscription_update.products` sans expansion (champ includable) ; présent avec `expand`', async () => {
    deploy(seedAccount());
    await tick();
    const id = portalConf().id;
    // État réel chez Stripe : six prix autorisés.
    expect(storedPrices()).toHaveLength(6);
    const plain = await rs.client.billingPortal.configurations.retrieve(id);
    expect(plain.features.subscription_update).not.toHaveProperty('products');
    const expanded = await rs.client.billingPortal.configurations.retrieve(id, { expand: [PRODUCTS_EXPAND_PATH] });
    expect((expanded.features.subscription_update.products ?? []).flatMap((p) => p.prices).sort()).toEqual(storedPrices());
  });

  it('STRIPE-P1-02 — incident « unique billing intervals » puis passage de la tâche : la reprise aboutit (ni PORTAL_MISMATCH ∅, ni PORTAL_RESTORE_FAILED, ni échec 1/5)', async () => {
    await intervalsIncident();
    at(40);
    const r = await runCatalogPublishTask();
    const st = store.states.get(CTX)!;
    expect(st.publicationError ?? '').not.toMatch(/PORTAL_MISMATCH|PORTAL_RESTORE_FAILED/);
    expect(r.error).toBeUndefined();
    expect(st).toMatchObject({ publicationState: 'ACTIVE', publishedManifestRevision: manifestRevision() });
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.status).toBe('DONE');
    forgetCatalogMemory();
    expect((await getPublicCatalog(t.deps)).offers.map((o) => o.unit_amount_cents)).toEqual(MANIFEST);
  });

  it('STRIPE-P1-03 — publication en échec, portail ALIGNÉ sur la révision active : le clic « monter en gamme » n’est pas bloqué (pas de 503 PORTAL_UPDATING)', async () => {
    deploy(seedAccount());
    await tick();
    await store.setBackfillCompleted(CTX, new Date());
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    rs.opts.portalFail = (_n, products) => (isNew(products) ? 'invalid' : null);
    const r = await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    rs.opts.portalFail = undefined;
    expect(r).toMatchObject({ status: 'failed', step: 'portal' });
    expect((r as { reason: string }).reason).not.toMatch(/NON restauré/);
    await expect(ensureUpgradePortalConfiguration(t.deps)).resolves.toBe(portalConf().id);
  });

  it('STRIPE-P1-04 — « Publier la grille du code » après reprise : plus de PREVIOUS_FAILURE (rien à publier)', async () => {
    await intervalsIncident();
    at(40);
    await runCatalogPublishTask();
    const r = await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    expect(r).toMatchObject({ status: 'noop', reason: 'NO_DIFFERENCE' });
    for (const c of CATALOG_COUPLES) {
      const p = await resolveCurrentPrice(c.planCode, c.billingPeriod, { forPayment: true }, t.deps);
      expect(p.priceId).toMatch(/^price_new_/);
    }
  });
});

// ─── Outils : état préprod reconstitué ──────────────────────────────────────

const creates = () => rs.calls.filter((c) => c === 'prices.create').length;
const keyUpdates = () => rs.calls.filter((c) => c.startsWith('prices.update')).length;
const writesCount = () => rs.calls.filter((c) => c === 'portal.update' || c === 'portal.create' || c === 'prices.create' || c.startsWith('prices.update') || c.startsWith('subscriptions.update')).length;
const fixedProbe = async () => 'subs-unchanged';
const PREPROD_ERROR = (cfg: string) => `portal: PORTAL_MISMATCH: portail ${cfg} : prix acceptés ∅ ≠ attendus price_new_1,price_new_2,price_new_3,price_new_4,price_new_5,price_new_6 ; portail NON restauré (PORTAL_RESTORE_FAILED: PORTAL_MISMATCH: portail ${cfg} : prix acceptés ∅ ≠ attendus price_seed_duo_m,price_seed_duo_y,price_seed_pre_m,price_seed_pre_y,price_seed_std_m,price_seed_std_y) : montées en gamme bloquées`;

/** Quatre abonnements historiques (anciens prix V2), tarif contractuel figé. */
function seedHistoricalSubscriptions() {
  const start = Math.floor(T0.getTime() / 1000) - 10 * 86400;
  const subs: Array<[string, string, number]> = [
    ['sub_hist_std_m', 'price_seed_std_m', 30], ['sub_hist_pre_m', 'price_seed_pre_m', 30],
    ['sub_hist_pre_y', 'price_seed_pre_y', 365], ['sub_hist_duo_y', 'price_seed_duo_y', 365],
  ];
  for (const [id, price, days] of subs) {
    rs.subscriptions.set(id, { id, customer: `cus_${id}`, status: 'active', itemId: `si_${id}`, priceId: price, current_period_start: start, current_period_end: start + days * 86400, billing_cycle_anchor: start });
  }
  return JSON.stringify([...rs.subscriptions.values()]);
}

/**
 * ÉTAT PRÉPROD RECONSTITUÉ (13/10/2026) : incident d'origine, puis rattrapage
 * 49A exécuté par l'ancien code et terminé FAILED après 1/5 avec l'erreur
 * exacte journalisée (PORTAL_MISMATCH ∅ + PORTAL_RESTORE_FAILED), portail
 * réellement revenu aux six anciens prix chez Stripe, anomalies ouvertes.
 */
async function preprodState(opts: RealisticOptions = {}) {
  await intervalsIncident(opts);
  const subsBefore = seedHistoricalSubscriptions();
  const st = store.states.get(CTX)!;
  const runId = st.publicationRunId!;
  const cfg = portalConf().id;
  st.publicationError = PREPROD_ERROR(cfg).slice(0, 500);
  await store.updateRun(runId, { state: 'FAILED', error: PREPROD_ERROR(cfg), finished: true, step: { step: 'portal-restore-failed', error: 'PORTAL_RESTORE_FAILED' } });
  await store.saveRecovery({
    catalogContext: CTX, recoveryKey: PORTAL_INTERVAL_RECOVERY.key, status: 'FAILED', runId, attempts: 1,
    lastError: PREPROD_ERROR(cfg).slice(0, 1000), lastAttemptAt: new Date(T0.getTime() + 25 * 60_000), nextAttemptAt: null, completedAt: null, report: null,
  });
  await t.deps.anomalies.report({ fingerprint: `stripe:catalog:${CTX}:publication`, title: 'publication en échec' });
  await t.deps.anomalies.report({ fingerprint: `stripe:catalog:${CTX}:portal-restore`, title: 'portail non restauré' });
  // Portail chez Stripe : la restauration (écriture acceptée) a remis les six anciens prix.
  expect(storedPrices()).toEqual(['price_seed_duo_m', 'price_seed_duo_y', 'price_seed_pre_m', 'price_seed_pre_y', 'price_seed_std_m', 'price_seed_std_y']);
  return { runId, cfg, subsBefore, runs: store.runs.length, creates: creates(), keyUpdates: keyUpdates() };
}

async function expectNewGridEverywhere() {
  forgetCatalogMemory();
  const pub = await getPublicCatalog(t.deps);
  expect(pub).toMatchObject({ status: 'ok', purchasable: true, reason: null });
  expect(pub.offers.map((o) => o.unit_amount_cents)).toEqual(MANIFEST);
  expect(pub.offers.every((o) => o.tax_included)).toBe(true);
  const st = (await store.getState(CTX))!;
  expect(st).toMatchObject({ publicationState: 'ACTIVE', publicationError: null, publishedManifestRevision: manifestRevision() });
  for (const c of CATALOG_COUPLES) {
    const r = await resolveCurrentPrice(c.planCode, c.billingPeriod, { forPayment: true }, t.deps);
    expect(r).toMatchObject({ lookupKey: c.lookupKey, taxBehavior: 'inclusive', unitAmountCents: EXPECTED_V4_GRID[c.planCode][c.billingPeriod] });
    expect(r.priceId).toMatch(/^price_new_/);
    expect(rs.prices.get(r.priceId)!.lookup_key).toBe(c.lookupKey);
    expect(pub.offers.find((o) => o.plan_code === c.planCode && o.billing_period === c.billingPeriod)!.price_revision).toBe(r.priceRevision);
  }
}

// ─── A — portail : écriture, relecture, absent ≠ vide ───────────────────────

describe('STRIPE-P1 — A : configuration du portail immediate_upgrade_v1', () => {
  it('STRIPE-P1-05 — propriété ABSENTE = indéterminé ; liste explicitement vide (ou null) = déterminé vide', () => {
    const base = { id: 'bpc_x', features: { subscription_update: { enabled: true, proration_behavior: 'always_invoice', default_allowed_updates: ['price'] } } } as unknown as Stripe.BillingPortal.Configuration;
    expect(readPortalProducts(base)).toEqual({ state: 'absent' });
    expect(acceptedProductsOf(base)).toBeNull();
    const empty = JSON.parse(JSON.stringify(base));
    empty.features.subscription_update.products = [];
    expect(readPortalProducts(empty)).toEqual({ state: 'present', products: [] });
    const nul = JSON.parse(JSON.stringify(base));
    nul.features.subscription_update.products = null;
    expect(readPortalProducts(nul)).toEqual({ state: 'present', products: [] });
    expect(PORTAL_PRODUCTS_EXPAND).toBe(PRODUCTS_EXPAND_PATH);
  });

  it('STRIPE-P1-06 — écriture puis RELECTURE étendue : exactement six prix, un mensuel + un annuel par produit approuvé', async () => {
    deploy(seedAccount());
    await tick();
    const id = portalConf().id;
    const reads = rs.portalReads.length;
    const r = await syncUpgradePortal({ reason: 'test', force: true, requireComplete: true }, t.deps);
    expect(r.configurationId).toBe(id);
    const lastWrite = rs.portalWrites[rs.portalWrites.length - 1];
    expect(lastWrite).toMatchObject({ op: 'update', accepted: true, productsSent: true });
    // Vérification faite sur un retrieve ÉTENDU dont la réponse contient la liste.
    const verify = rs.portalReads.slice(reads).filter((x) => x.op === 'retrieve' && x.expand.includes(PRODUCTS_EXPAND_PATH));
    expect(verify.length).toBeGreaterThan(0);
    expect(verify.every((x) => x.productsReturned)).toBe(true);
    const stored = portalConf().features.subscription_update.products!;
    expect(stored).toHaveLength(3);
    for (const p of stored) {
      expect(p.prices.map((id2) => rs.prices.get(id2)!.recurring!.interval).sort()).toEqual(['month', 'year']);
    }
    expect((await store.getState(CTX))!.portalConfigurationId).toBe(id);
  });

  it('STRIPE-P1-07 — vérification sur la réponse Stripe, jamais sur le tableau local : un prix non retenu par Stripe → PORTAL_MISMATCH', async () => {
    deploy(seedAccount());
    await tick();
    const update = rs.client.billingPortal.configurations.update.bind(rs.client.billingPortal.configurations);
    (rs.client.billingPortal.configurations as unknown as { update: unknown }).update = async (id: string, params: never) => {
      const res = await update(id, params);
      const c = rs.portal.get(id)!;
      c.features.subscription_update.products = c.features.subscription_update.products!.map((p, i) => (i === 0 ? { ...p, prices: p.prices.slice(0, 1) } : p));
      return res;
    };
    await expect(syncUpgradePortal({ reason: 'test', force: true }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_MISMATCH', message: expect.stringMatching(/prix manquants/) });
  });

  it('STRIPE-P1-08 — propriété absente MÊME avec expansion : PORTAL_UNVERIFIABLE (indéterminé), jamais « ∅ », rien de mémorisé', async () => {
    deploy(seedAccount());
    await tick();
    const before = (await store.getState(CTX))!.portalFingerprint;
    rs.opts.omitProductsEvenExpanded = true;
    const e = await syncUpgradePortal({ reason: 'test', force: true }, t.deps).catch((x) => x);
    expect(e).toMatchObject({ code: 'PORTAL_UNVERIFIABLE' });
    expect(e.message).toMatch(/indéterminé/);
    expect(e.message).not.toMatch(/∅/);
    expect((await store.getState(CTX))!.portalFingerprint).toBe(before);
    expect(t.anomalies.some((a) => /indéterminé/.test(a.title))).toBe(true);
    expect((await capturePortalConfiguration(t.deps))!.products).toBeNull();
  });

  it('STRIPE-P1-09 — expansion refusée par Stripe : repli sans expansion, état INDÉTERMINÉ (aucun succès supposé)', async () => {
    deploy(seedAccount());
    await tick();
    rs.opts.rejectProductsExpand = true;
    await expect(syncUpgradePortal({ reason: 'test', force: true }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_UNVERIFIABLE' });
    // L'écriture a bien été faite (sans expansion) — seule la preuve manque.
    expect(rs.portalWrites[rs.portalWrites.length - 1]).toMatchObject({ accepted: true });
  });

  it('STRIPE-P1-10 — liste explicitement VIDE relue : état déterminé, PORTAL_MISMATCH « ∅ (liste explicitement vide) »', async () => {
    deploy(seedAccount());
    await tick();
    const update = rs.client.billingPortal.configurations.update.bind(rs.client.billingPortal.configurations);
    (rs.client.billingPortal.configurations as unknown as { update: unknown }).update = async (id: string, params: never) => {
      const res = await update(id, params);
      rs.portal.get(id)!.features.subscription_update.products = [];
      return res;
    };
    await expect(syncUpgradePortal({ reason: 'test', force: true }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_MISMATCH', message: expect.stringMatching(/∅ \(liste explicitement vide\)/) });
  });

  it('STRIPE-P1-11 — prix ÉTRANGER présent chez Stripe (ajouté hors Verebona) : PORTAL_MISMATCH « prix étrangers »', async () => {
    deploy(seedAccount());
    await tick();
    const update = rs.client.billingPortal.configurations.update.bind(rs.client.billingPortal.configurations);
    (rs.client.billingPortal.configurations as unknown as { update: unknown }).update = async (id: string, params: never) => {
      const res = await update(id, params);
      rs.portal.get(id)!.features.subscription_update.products!.push({ product: 'prod_autre', prices: ['price_autre'] } as never);
      return res;
    };
    await expect(syncUpgradePortal({ reason: 'test', force: true }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_MISMATCH', message: expect.stringMatching(/prix étrangers price_autre/) });
  });

  it('STRIPE-P1-12 — refus AVANT tout appel : produit non approuvé, doublon de périodicité, grille incomplète, liste vide jamais écrite', async () => {
    deploy(seedAccount());
    await tick();
    const writes = rs.portalWrites.length;
    const snap = JSON.parse(JSON.stringify((await store.getState(CTX))!.activeSnapshot));
    // Produit non approuvé pour la vente.
    const foreign = JSON.parse(JSON.stringify(snap));
    for (const k of ['standard:monthly', 'standard:yearly']) foreign.entries[k].productId = 'prod_inconnu';
    await expect(syncUpgradePortal({ reason: 't', snapshot: foreign, persist: false, requireComplete: true }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_PRODUCT_NOT_APPROVED' });
    expect(completeGridIssues(portalPriceRefs(foreign), await store.listApprovedProducts(CTX)).join()).toMatch(/non approuvé/);
    // Doublon de périodicité.
    const dup = JSON.parse(JSON.stringify(snap));
    dup.entries['premium:monthly'].productId = dup.entries['standard:monthly'].productId;
    await expect(syncUpgradePortal({ reason: 't', snapshot: dup, persist: false }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_DUPLICATE_INTERVAL' });
    // Grille incomplète.
    const partial = JSON.parse(JSON.stringify(snap));
    delete partial.entries['premium_duo:yearly'];
    await expect(syncUpgradePortal({ reason: 't', snapshot: partial, persist: false, requireComplete: true }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_INCOMPLETE' });
    // Liste vide : la restauration ne l'écrit jamais.
    await expect(restorePortalConfiguration({ configurationId: portalConf().id, products: [], settingsOk: true }, null, 't', t.deps)).rejects.toMatchObject({ code: 'PORTAL_RESTORE_FAILED' });
    expect(rs.portalWrites.length).toBe(writes);
  });

  it('STRIPE-P1-13 — sauvegarde prise alors que `products` était ABSENT : restauration sur la révision active, relue et vérifiée', async () => {
    deploy(seedAccount());
    await tick();
    rs.opts.omitProductsEvenExpanded = true;
    const backup = await capturePortalConfiguration(t.deps);
    expect(backup).toMatchObject({ products: null });
    rs.opts.omitProductsEvenExpanded = false;
    // Portail modifié entre-temps (candidat d'une publication).
    const old = (await store.getState(CTX))!.activeSnapshot!;
    rs.portal.get(portalConf().id)!.features.subscription_update.products = [{ product: 'prod_seed_std', prices: ['price_seed_std_m'] }] as never;
    const r = await restorePortalConfiguration(backup, old, 'test', t.deps);
    expect(r).toMatchObject({ source: 'active-revision', backup: 'indeterminate' });
    expect(acceptedProductsOf(portalConf())).toEqual(portalProductsFor(old));
  });

  it('STRIPE-P1-14 — sauvegarde RELUE (déterminée) : restaurée telle quelle puis vérifiée par relecture', async () => {
    deploy(seedAccount());
    await tick();
    const backup = (await capturePortalConfiguration(t.deps))!;
    expect(backup.products!.flatMap((p) => p.prices)).toHaveLength(6);
    rs.portal.get(portalConf().id)!.features.subscription_update.products = [{ product: 'prod_seed_std', prices: ['price_seed_std_m'] }] as never;
    const r = await restorePortalConfiguration(backup, (await store.getState(CTX))!.activeSnapshot, 'test', t.deps);
    expect(r).toMatchObject({ source: 'backup', backup: 'used' });
    expect(acceptedProductsOf(portalConf())).toEqual(backup.products);
  });

  it('STRIPE-P1-15 — activation qui échoue : portail restauré et vérifié, ancienne grille vendue, montées en gamme ouvertes', async () => {
    deploy(seedAccount());
    await tick();
    await store.setBackfillCompleted(CTX, new Date());
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    const old = acceptedProductsOf(portalConf());
    const activate = store.activateSnapshot.bind(store);
    store.activateSnapshot = async () => { throw new Error('base indisponible'); };
    const r = await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    store.activateSnapshot = activate;
    expect(r).toMatchObject({ status: 'failed' });
    expect((r as { reason: string }).reason).not.toMatch(/NON restauré/);
    expect(acceptedProductsOf(portalConf())).toEqual(old);
    expect(store.runs[store.runs.length - 1].steps.find((x) => x.step === 'portal-restored')).toMatchObject({ source: 'backup', backup: 'used' });
    await expect(ensureUpgradePortalConfiguration(t.deps)).resolves.toBe(portalConf().id);
  });

  it('STRIPE-P1-16 — restauration impossible : blocage DURABLE (PORTAL_BLOCKED), jamais « réessayez dans quelques minutes »', async () => {
    deploy(seedAccount());
    await tick();
    await store.setBackfillCompleted(CTX, new Date());
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    // Candidat accepté par Stripe, puis activation en échec ET restauration refusée.
    rs.opts.portalFail = (_n, products) => (products.some((p) => p.prices.some((id) => id.startsWith('price_seed_'))) ? 'invalid' : null);
    const activate = store.activateSnapshot.bind(store);
    store.activateSnapshot = async () => { throw new Error('base indisponible'); };
    const r = await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    store.activateSnapshot = activate;
    expect((r as { reason: string }).reason).toMatch(/NON restauré/);
    await expect(ensureUpgradePortalConfiguration(t.deps)).rejects.toMatchObject({ code: 'PORTAL_BLOCKED' });
    const route = readFileSync(resolve(__dirname, '../../../app/api/billing/upgrade/route.ts'), 'utf8');
    const msg = /PORTAL_BLOCKED: "([^"]+)"/.exec(route)?.[1] ?? '';
    expect(msg).toMatch(/Aucun changement n'a été fait/);
    expect(msg).not.toMatch(/réessayez/i);
    expect(route).toMatch(/result\.reason === 'PORTAL_BLOCKED' \? 503/);
  });

  it('STRIPE-P1-18 — état intermédiaire : « réessayez » (PORTAL_UPDATING) seulement s’il est récent ; figé > 30 min → PORTAL_BLOCKED', async () => {
    deploy(seedAccount());
    await tick();
    const st = store.states.get(CTX)!;
    st.publicationState = 'RECOVERING';
    rs.portal.get(portalConf().id)!.features.subscription_update.products = [{ product: 'prod_seed_std', prices: ['price_seed_std_m'] }] as never;
    st.updatedAt = new Date(T0.getTime() - 60_000);
    await expect(ensureUpgradePortalConfiguration(t.deps)).rejects.toMatchObject({ code: 'PORTAL_UPDATING' });
    st.updatedAt = new Date(T0.getTime() - 2 * 3600_000);
    await expect(ensureUpgradePortalConfiguration(t.deps)).rejects.toMatchObject({ code: 'PORTAL_BLOCKED' });
  });
});

// ─── B / C — reprise corrective unique, ciblée, idempotente ────────────────

describe('STRIPE-P1 — B/C : reprise corrective automatique et activation', () => {
  it('STRIPE-P1-20 — état préprod reconstitué → passage de la tâche : publication ACTIVE, six clés conformes, grille partout, aucun Price créé', async () => {
    const inc = await preprodState();
    at(60);
    const r = await runCatalogPublishTask();
    expect(r.error).toBeUndefined();
    expect(r.note).toMatch(new RegExp(`rattrapage ${PORTAL_PRODUCTS_RECOVERY.key} : done`));
    await expectNewGridEverywhere();
    // Même exécution, mêmes six Price, aucun transfert de clé (déjà faits).
    expect(store.runs).toHaveLength(inc.runs);
    expect(creates()).toBe(inc.creates);
    expect(keyUpdates()).toBe(inc.keyUpdates);
    const run = store.runs[inc.runId - 1];
    expect(run.state).toBe('ACTIVE');
    expect(run.transfers.filter((x) => x.already)).toHaveLength(6);
    expect(run.report).toMatchObject({ complete: true, portalFinal: { ok: true } });
    // Révision activée, historique conservé (précédente = ancienne grille, registre complet).
    const st = (await store.getState(CTX))!;
    expect(st.previousSnapshot!.entries['standard:monthly']!.unitAmountCents).toBe(290);
    expect(await store.findPriceVersion(CTX, 'price_seed_std_m')).toMatchObject({ unitAmountCents: 290 });
    for (const c of CATALOG_COUPLES) expect(await store.findPriceVersion(CTX, st.activeSnapshot!.entries[coupleKey(c.planCode, c.billingPeriod)]!.priceId)).not.toBeNull();
    expect(st.portalConfigurationId).toBe(inc.cfg);
    // Portail chez Stripe : exactement les six nouveaux prix.
    expect(storedPrices()).toEqual(newPrices().map((p) => p.id).sort());
    // Aucune revalorisation, abonnements historiques intacts.
    expect(campaigns).toHaveLength(0);
    expect(JSON.stringify([...rs.subscriptions.values()])).toBe(inc.subsBefore);
    expect(rs.calls.some((c) => c.startsWith('subscriptions.update'))).toBe(false);
    // Reprise tracée comme terminée, contrôles réussis ; 49A conservé en historique.
    const row = (await store.getRecovery(CTX, PORTAL_PRODUCTS_RECOVERY.key))!;
    expect(row).toMatchObject({ status: 'DONE', attempts: 1, runId: inc.runId, lastError: null });
    expect(row.report).toMatchObject({ checks: { ok: true }, subscriptionsUnchanged: true, pricesCreated: 0, revaluation: 'aucune', step: 'terminee' });
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.status).toBe('FAILED');
    for (const fp of ['publication', 'portal-restore', `recovery:${PORTAL_INTERVAL_RECOVERY.key}`]) expect(t.resolved).toContain(`stripe:catalog:${CTX}:${fp}`);
  });

  it('STRIPE-P1-21 — BO après reprise : six clés « Conforme au code », publication complète, reprise « Terminé »', async () => {
    await preprodState();
    at(60);
    await runCatalogPublishTask();
    const diag = await getCatalogDiagnostic();
    expect(diag.couples.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(diag.couples.map((c) => c.unitAmountCents)).toEqual(MANIFEST);
    expect(diag.state).toMatchObject({ publicationState: 'ACTIVE', publishedManifestRevision: manifestRevision() });
    expect(diag.manifest.revision).toBe(diag.state!.publishedManifestRevision);
    expect(diag.publication.complete).toBe(true);
    const rec = diag.recoveries.find((x) => x.key === PORTAL_PRODUCTS_RECOVERY.key)!;
    expect(rec.display).toMatchObject({ phase: 'done', actionRequired: false });
    expect(diag.recovery.key).toBe(PORTAL_PRODUCTS_RECOVERY.key);
  });

  it('STRIPE-P1-22 — second passage (et suivants) : aucun effet, aucune écriture Stripe, aucune nouvelle tentative', async () => {
    await preprodState();
    at(60);
    await runCatalogPublishTask();
    const calls = rs.calls.length;
    const row = await store.getRecovery(CTX, PORTAL_PRODUCTS_RECOVERY.key);
    for (const m of [70, 130, 600]) {
      at(m);
      expect((await runCatalogPublishTask()).note).toMatch(/ALREADY_PUBLISHED/);
    }
    expect(rs.calls.length).toBe(calls);
    expect(await store.getRecovery(CTX, PORTAL_PRODUCTS_RECOVERY.key)).toMatchObject({ attempts: row!.attempts, status: 'DONE' });
    expect(await runPortalProductsRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'ALREADY_DONE' });
  });

  it('STRIPE-P1-23 — GARDE LIVE : clé sk_live, mode attendu live, environnement de production, état livemode, contexte live → aucune reprise, aucune lecture Stripe', async () => {
    expect(liveGuard({ mode: 'test', appEnv: 'preprod', env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_EXPECTED_MODE: 'test' } })).toBeNull();
    expect(liveGuard({ mode: 'live', appEnv: 'preprod', env: {} })).toBe('LIVE_GUARD:KEY_MODE');
    expect(liveGuard({ mode: 'test', appEnv: 'preprod', env: { STRIPE_SECRET_KEY: 'sk_live_x' } })).toBe('LIVE_GUARD:SECRET_KEY');
    expect(liveGuard({ mode: 'test', appEnv: 'preprod', env: { STRIPE_SECRET_KEY: 'rk_live_x' } })).toBe('LIVE_GUARD:SECRET_KEY');
    expect(liveGuard({ mode: 'test', appEnv: 'preprod', env: { STRIPE_EXPECTED_MODE: 'live' } })).toBe('LIVE_GUARD:EXPECTED_MODE');
    expect(liveGuard({ mode: 'test', appEnv: 'preprod', env: { NEXT_PUBLIC_APP_ENV: 'production' } })).toBe('LIVE_GUARD:EXPECTED_MODE');
    expect(liveGuard({ mode: 'test', appEnv: 'production', env: {} })).toBe('LIVE_GUARD:APP_ENV');
    expect(liveGuard({ mode: 'test', appEnv: 'preprod', env: {}, stateLivemode: true })).toBe('LIVE_GUARD:STATE_LIVEMODE');

    for (const variant of [
      { env: { STRIPE_SECRET_KEY: 'sk_live_51x' }, reason: 'LIVE_GUARD:SECRET_KEY' },
      { env: { STRIPE_EXPECTED_MODE: 'live' }, reason: 'LIVE_GUARD:EXPECTED_MODE' },
      { env: { NEXT_PUBLIC_APP_ENV: 'prod', STRIPE_EXPECTED_MODE: 'test' }, reason: 'LIVE_GUARD:APP_ENV' },
      { state: true, reason: 'LIVE_GUARD:STATE_LIVEMODE' },
    ] as Array<{ env?: Record<string, string>; state?: boolean; reason: string }>) {
      await preprodState();
      Object.assign(t.deps.env, variant.env ?? {});
      if (variant.state) store.states.get(CTX)!.livemode = true;
      const calls = rs.calls.length;
      at(60);
      expect(await runCatalogRecoveries(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: variant.reason });
      expect(rs.calls.length).toBe(calls);
      expect(await store.getRecovery(CTX, PORTAL_PRODUCTS_RECOVERY.key)).toBeNull();
      expect(store.states.get(CTX)!.publicationState).toBe('FAILED');
    }
    // Contexte live : hors cible avant toute lecture.
    await preprodState();
    const calls = rs.calls.length;
    expect(await runPortalProductsRecovery({ ...t.deps, context: () => ({ mode: 'live', appEnv: 'production', catalogContext: 'live:production' }) })).toMatchObject({ status: 'skipped', reason: 'OUT_OF_SCOPE_CONTEXT' });
    expect(rs.calls.length).toBe(calls);
  });

  it('STRIPE-P1-24 — autre compte Stripe : ignoré, aucune ligne ni écriture', async () => {
    await preprodState({ accountId: 'acct_autre' });
    at(60);
    const writes = writesCount();
    expect(await runPortalProductsRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'OTHER_ACCOUNT' });
    expect(writesCount()).toBe(writes);
    expect(await store.getRecovery(CTX, PORTAL_PRODUCTS_RECOVERY.key)).toBeNull();
  });

  it('STRIPE-P1-25 — deux instances simultanées : une seule reprise (verrou partagé)', async () => {
    const inc = await preprodState();
    at(60);
    const [a, b] = await Promise.all([
      runPortalProductsRecovery(t.deps, { subscriptionsProbe: fixedProbe }),
      runPortalProductsRecovery(t.deps, { subscriptionsProbe: fixedProbe }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['done', 'skipped']);
    expect([a, b].find((x) => x.status === 'skipped')).toMatchObject({ reason: 'LOCKED' });
    expect(store.runs[inc.runId - 1].steps.filter((x) => x.step === 'resume')).toHaveLength(1);
    expect(creates()).toBe(inc.creates);
  });

  it('STRIPE-P1-26 — interruption (processus arrêté en pleine reprise) : reprise idempotente au passage suivant, sans doublon', async () => {
    const inc = await preprodState();
    at(60);
    // Le portail ne répond jamais : le processus est « tué » pendant l'écriture.
    const update = rs.client.billingPortal.configurations.update.bind(rs.client.billingPortal.configurations);
    let hang = true;
    let hanging = false;
    (rs.client.billingPortal.configurations as unknown as { update: unknown }).update = (id: string, params: never) => {
      if (!hang) return update(id, params);
      hanging = true;
      return new Promise(() => {});
    };
    void runPortalProductsRecovery(t.deps, { subscriptionsProbe: fixedProbe });
    await vi.waitFor(() => expect(hanging).toBe(true));
    expect(['RECOVERING', 'PUBLISHING']).toContain(store.states.get(CTX)!.publicationState);
    expect((await store.getRecovery(CTX, PORTAL_PRODUCTS_RECOVERY.key))!.status).toBe('RUNNING');
    hang = false;
    // Nouvelle instance (bail mémoire de l'ancienne perdu avec le processus).
    const t2 = testDeps(store, rs.client, { env: t.deps.env });
    t2.setNow(new Date(T0.getTime() + 65 * 60_000));
    expect(await runPortalProductsRecovery(t2.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'NOT_FAILED' });
    t2.setNow(new Date(T0.getTime() + 80 * 60_000)); // bail (15 min) expiré
    __setCatalogDepsForTests(t2.deps);
    const r = await runPortalProductsRecovery(t2.deps, { subscriptionsProbe: fixedProbe });
    expect(r).toMatchObject({ status: 'done' });
    expect((await store.getRecovery(CTX, PORTAL_PRODUCTS_RECOVERY.key))!).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(creates()).toBe(inc.creates);
    expect(keyUpdates()).toBe(inc.keyUpdates);
    t = t2;
    await expectNewGridEverywhere();
  });

  it('STRIPE-P1-27 — panne Stripe passagère : reprises espacées et bornées (5), puis échec définitif visible, sans boucle', async () => {
    await preprodState();
    rs.opts.portalFail = (_n, products) => (isNew(products) ? 'transient' : null);
    let minute = 60;
    for (let i = 1; i <= RECOVERY_MAX_ATTEMPTS; i++) {
      at(minute);
      const r = await runPortalProductsRecovery(t.deps, { subscriptionsProbe: fixedProbe });
      expect(r.status).toBe(i < RECOVERY_MAX_ATTEMPTS ? 'retry_wait' : 'failed');
      minute += recoveryDelayMs(i) / 60_000 + 1;
    }
    const row = (await store.getRecovery(CTX, PORTAL_PRODUCTS_RECOVERY.key))!;
    expect(row).toMatchObject({ status: 'FAILED', attempts: RECOVERY_MAX_ATTEMPTS });
    expect(row.report).toMatchObject({ blocking: { step: 'portal' }, definitive: true });
    at(minute + 600);
    expect(await runPortalProductsRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'RECOVERY_FAILED' });
    // Ancienne grille toujours vendue.
    expect(store.states.get(CTX)!.activeSnapshot!.entries['standard:monthly']!.unitAmountCents).toBe(290);
  });

  it('STRIPE-P1-28 — ciblage pur : erreurs visées, rattrapage 49A actif prioritaire, ligne terminée ignorée', () => {
    const base = { catalogContext: CTX, mode: 'test', publicationState: 'FAILED', publicationError: PREPROD_ERROR('bpc_1'), publicationRunId: 3 };
    const row49 = (status: 'FAILED' | 'RUNNING') => ({ catalogContext: CTX, recoveryKey: PORTAL_INTERVAL_RECOVERY.key, status, runId: 3, attempts: 1, lastError: null, lastAttemptAt: null, nextAttemptAt: null, completedAt: null, report: null });
    expect(recoveryTargetsFor(PORTAL_PRODUCTS_RECOVERY, base, null, [row49('FAILED')])).toEqual({ targeted: true, reason: 'INCIDENT' });
    expect(recoveryTargetsFor(PORTAL_PRODUCTS_RECOVERY, base, null, [row49('RUNNING')])).toMatchObject({ targeted: false, reason: 'PREVIOUS_RECOVERY_ACTIVE' });
    expect(recoveryTargetsFor(PORTAL_PRODUCTS_RECOVERY, { ...base, publicationError: 'transfer: Stripe down' }, null)).toMatchObject({ targeted: false, reason: 'UNRELATED_ERROR' });
    expect(recoveryTargetsFor(PORTAL_PRODUCTS_RECOVERY, { ...base, publicationError: 'portal: PORTAL_UNVERIFIABLE: x' }, null).targeted).toBe(true);
    expect(recoveryTargetsFor(PORTAL_PRODUCTS_RECOVERY, { ...base, catalogContext: 'live:production', mode: 'live' }, null)).toMatchObject({ targeted: false, reason: 'OUT_OF_SCOPE_CONTEXT' });
    expect(recoveryTargetsFor(PORTAL_PRODUCTS_RECOVERY, { ...base, publicationState: 'ACTIVE' }, null).targeted).toBe(false);
  });
});

// ─── D — interfaces et paiements ────────────────────────────────────────────

describe('STRIPE-P1 — D : Checkout, montée en gamme, interfaces', () => {
  it('STRIPE-P1-30 — Checkout : les six bons Price, révision confirmée ; prix changé entre affichage et validation → confirmation explicite (PRICE_CHANGED)', async () => {
    await preprodState();
    forgetCatalogMemory();
    const displayedBefore = (await getPublicCatalog(t.deps)).offers.find((o) => o.plan_code === 'premium' && o.billing_period === 'monthly')!;
    expect(displayedBefore.unit_amount_cents).toBe(590); // ancienne grille affichée tant que la reprise n'est pas passée
    at(60);
    await runCatalogPublishTask();
    const resolved = await resolveCurrentPrice('premium', 'monthly', { forPayment: true }, t.deps);
    expect(resolved.unitAmountCents).toBe(690);
    expect(() => assertDisplayedRevision(resolved, displayedBefore.price_revision)).toThrow(expect.objectContaining({ code: 'PRICE_CHANGED' }));
    expect(() => assertDisplayedRevision(resolved, resolved.priceRevision)).not.toThrow();
    const ids = new Set<string>();
    for (const c of CATALOG_COUPLES) ids.add((await resolveCurrentPrice(c.planCode, c.billingPeriod, { forPayment: true }, t.deps)).priceId);
    expect([...ids].sort()).toEqual(newPrices().map((p) => p.id).sort());
  });

  it('STRIPE-P1-31 — montée en gamme Premium → Premium Duo via le portail : prix Duo V4 accepté, prorata facturé immédiatement, échéance maintenue', async () => {
    await preprodState();
    at(60);
    await runCatalogPublishTask();
    const sub = rs.subscriptions.get('sub_hist_pre_m')!;
    const configuration = await ensureUpgradePortalConfiguration(t.deps);
    const target = await resolveCurrentPrice('premium_duo', 'monthly', { forPayment: true }, t.deps);
    const session = await rs.client.billingPortal.sessions.create({
      customer: sub.customer, configuration, flow_data: { type: 'subscription_update_confirm', subscription_update_confirm: { subscription: sub.id, items: [{ id: sub.itemId, price: target.priceId, quantity: 1 }] } },
    } as never);
    const now = sub.current_period_start + 15 * 86400; // mi-période
    const after = rs.confirmPortalSession(session.id, now);
    expect(after).toMatchObject({ priceId: target.priceId, current_period_end: sub.current_period_end, billing_cycle_anchor: sub.billing_cycle_anchor });
    const inv = rs.invoices.find((i) => i.subscription === sub.id)!;
    const ratio = (sub.current_period_end - now) / (sub.current_period_end - sub.current_period_start);
    expect(inv.amount).toBe(Math.round(990 * ratio) - Math.round(590 * ratio));
    expect(inv.amount).toBeGreaterThan(0);
    // L'ancien prix Duo n'est plus une cible proposée (LK-50).
    await expect(rs.client.billingPortal.sessions.create({
      customer: sub.customer, configuration, flow_data: { type: 'subscription_update_confirm', subscription_update_confirm: { subscription: sub.id, items: [{ id: sub.itemId, price: 'price_seed_duo_m', quantity: 1 }] } },
    } as never)).rejects.toThrow(/not allowed/);
    // Les autres abonnements historiques n'ont pas bougé.
    expect(rs.subscriptions.get('sub_hist_duo_y')!.priceId).toBe('price_seed_duo_y');
  });

  it('STRIPE-P1-32 — caches : au-delà de leur durée de validité, une instance qui avait l’ancienne grille en mémoire sert la nouvelle (vitrine + Mon compte › Offres : même API)', async () => {
    await preprodState();
    const oldState = structuredClone(store.states.get(CTX)!);
    at(60);
    await runCatalogPublishTask();
    const newState = structuredClone(store.states.get(CTX)!);
    expect(newState.generation).toBeGreaterThan(oldState.generation);
    // Cette instance a lu l'ancienne grille juste avant l'activation faite par une AUTRE instance.
    store.states.set(CTX, structuredClone(oldState));
    forgetCatalogMemory();
    expect((await getPublicCatalog(t.deps)).offers[0].unit_amount_cents).toBe(290);
    store.states.set(CTX, structuredClone(newState)); // activation par l'autre instance (mémoire locale non vidée)
    const ttl = memoryTtlMs({} as NodeJS.ProcessEnv);
    expect(ttl).toBeLessThanOrEqual(30_000);
    expect(presentationTtlSeconds({} as NodeJS.ProcessEnv)).toBeLessThanOrEqual(300);
    t.setNow(new Date(t.deps.now().getTime() + ttl - 1_000));
    expect((await getPublicCatalog(t.deps)).offers[0].unit_amount_cents).toBe(290); // encore dans la fenêtre bornée
    t.setNow(new Date(t.deps.now().getTime() + 2_000));
    expect((await getPublicCatalog(t.deps)).offers.map((o) => o.unit_amount_cents)).toEqual(MANIFEST);
    // Desktop et mobile : une seule source (catalogue public), aucun montant codé en dur.
    const client = readFileSync(resolve(__dirname, '../../../lib/billing/catalog-client.ts'), 'utf8');
    expect(client).toMatch(/\/api\/billing\/catalog/);
  });

  it('STRIPE-P1-33 — abonnements historiques : tarif contractuel conservé, prix anciens reconnus au registre, aucune revalorisation automatique', async () => {
    const inc = await preprodState();
    at(60);
    await runCatalogPublishTask();
    expect(JSON.stringify([...rs.subscriptions.values()])).toBe(inc.subsBefore);
    for (const id of ['price_seed_std_m', 'price_seed_pre_m', 'price_seed_pre_y', 'price_seed_duo_y']) {
      expect(rs.prices.get(id)).toMatchObject({ active: true });
      expect(await store.findPriceVersion(CTX, id)).not.toBeNull();
    }
    expect(campaigns).toHaveLength(0);
    expect(rs.invoices).toHaveLength(0);
  });
});

// ─── E — supervision ────────────────────────────────────────────────────────

describe('STRIPE-P1 — E : supervision BO', () => {
  it('STRIPE-P1-40 — quatre statuts distincts ; « aucune action nécessaire » jamais affiché sur un échec définitif', () => {
    const phases = (['RUNNING', 'WAITING', 'RETRY_WAIT', 'FAILED', 'CHECK_FAILED', 'DONE'] as const).map((s) => recoveryDisplay({ status: s }, false)!.phase);
    expect(phases).toEqual(['in_progress', 'pending', 'pending', 'failed', 'failed', 'done']);
    expect(recoveryDisplay(null, true)!.phase).toBe('pending');
    expect(recoveryDisplay(null, false)).toBeNull();
    expect(Object.values(RECOVERY_PHASE_LABELS)).toEqual(['En cours', 'En attente', 'Échec définitif', 'Terminé']);
    for (const s of ['FAILED', 'CHECK_FAILED'] as const) {
      const d = recoveryDisplay({ status: s }, false)!;
      expect(d.actionRequired).toBe(true);
      expect(`${d.label} ${d.guidance}`).not.toMatch(/aucune action/i);
      expect(`${d.label} ${d.guidance}`).not.toMatch(/réessayez/i);
    }
    const panel = readFileSync(resolve(__dirname, '../../../app/admin/exploitation/_components/StripeCatalogPanel.tsx'), 'utf8');
    expect(panel).not.toMatch(/aucune action n’est nécessaire dans le BO ni dans Stripe\./);
  });

  it('STRIPE-P1-41 — état préprod avant reprise : BO = échec définitif du 49A (étape, erreur, 1/5) + reprise lot 53 « En attente » ; publication bloquée expliquée', async () => {
    await preprodState();
    vi.stubEnv('STRIPE_EXPECTED_MODE', 'test');
    const diag = await getCatalogDiagnostic();
    vi.unstubAllEnvs();
    const r49 = diag.recoveries.find((x) => x.key === PORTAL_INTERVAL_RECOVERY.key)!;
    expect(r49.display).toMatchObject({ phase: 'failed', actionRequired: true });
    expect(r49.row).toMatchObject({ attempts: 1, status: 'FAILED' });
    expect(r49.row!.lastError).toMatch(/PORTAL_MISMATCH/);
    const r53 = diag.recoveries.find((x) => x.key === PORTAL_PRODUCTS_RECOVERY.key)!;
    expect(r53).toMatchObject({ pending: true, display: { phase: 'pending', actionRequired: false } });
    expect(diag.recovery.key).toBe(PORTAL_PRODUCTS_RECOVERY.key);
    expect(diag.publicCatalog.publicationBlocker).toBe('PREVIOUS_FAILURE');
    expect(explainCatalogReason('PREVIOUS_FAILURE')!.label).toMatch(/publication précédente est en échec/);
  });

  it('STRIPE-P1-42 — échec définitif de la reprise : étape bloquante, erreur et tentatives exposées au BO', async () => {
    await preprodState();
    rs.opts.portalFail = (_n, products) => (isNew(products) ? 'invalid' : null);
    at(60);
    const task = await runCatalogPublishTask();
    expect(task.error).toMatch(/rattrapage de la publication en échec/);
    const diag = await getCatalogDiagnostic();
    const r53 = diag.recoveries.find((x) => x.key === PORTAL_PRODUCTS_RECOVERY.key)!;
    expect(r53.display).toMatchObject({ phase: 'failed', actionRequired: true });
    expect(r53.step).toMatchObject({ code: 'portal' });
    expect(r53.row).toMatchObject({ attempts: 1 });
    expect(r53.row!.lastError).toMatch(/Invalid portal configuration/);
  });

  it('STRIPE-P1-43 — vérification finale du portail en échec : publication active mais NON « intégralement réussie » (tâche en erreur, BO)', async () => {
    deploy(seedAccount());
    await tick();
    await store.setBackfillCompleted(CTX, new Date());
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    // Le portail accepte le candidat, puis la relecture finale est indéterminée.
    const retrieve = rs.client.billingPortal.configurations.retrieve.bind(rs.client.billingPortal.configurations);
    (rs.client.billingPortal.configurations as unknown as { retrieve: unknown }).retrieve = async (id: string, params?: { expand?: string[] }) => {
      const final = store.runs.length > 0 && store.runs[store.runs.length - 1].steps.some((x) => x.step === 'activated');
      rs.opts.omitProductsEvenExpanded = final;
      return retrieve(id, params);
    };
    const task = await runCatalogPublishTask();
    expect(task.error).toMatch(/publication active mais vérification incomplète/);
    const run = store.runs[store.runs.length - 1];
    expect(run.report).toMatchObject({ complete: false, portalFinal: { ok: false } });
    expect(t.anomalies.some((a) => a.fingerprint === `stripe:catalog:${CTX}:portal-final`)).toBe(true);
    const diag = await getCatalogDiagnostic();
    expect(diag.publication.complete).toBe(false);
  });
});
