/**
 * Lot 49A — Stripe : doublons du portail et reprise automatique de la
 * publication échouée en préproduction.
 *
 * Compte Stripe SIMULÉ réaliste (helpers/realistic-stripe) dont le portail
 * applique la règle réelle : « For each product, its price must have unique
 * billing intervals. » (erreur constatée en préprod, contexte test:preprod,
 * compte acct_1SX8QQL7bbQ8HKBX). Les scénarios passent par les VRAIES tâches
 * planifiées (`stripe-catalog-sync`, `stripe-catalog-publish`) jusqu'au
 * catalogue public (vitrine, page Offres) et à la relecture Checkout.
 *
 * L'état d'incident est reconstruit tel qu'en préprod : grille V2 vendue,
 * six nouveaux Price créés, clés transférées, portail refusé par Stripe sur
 * l'union ancienne + nouvelle révision, état FAILED « unexpected: For each
 * product, its price must have unique billing intervals. ».
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
vi.mock('../price-backfill.service', () => ({ runPriceBackfill: vi.fn(async () => ({ completed: true, blocking: 0 })) }));

import { CATALOG_COUPLES, coupleKey } from '@/lib/billing/plan-catalog';
import { __setCatalogDepsForTests, forgetCatalogMemory, getPublicCatalog, resolveCurrentPrice } from '../price-catalog.service';
import { AUTO_PUBLISH_DELAY_MS, publicationStopped, publishCodeCatalog, runAutoPublication } from '../catalog-publication.service';
import { runCatalogPublishTask, runCatalogSyncTask } from '../catalog-tasks';
import {
  EXPECTED_V4_GRID, PORTAL_INTERVAL_RECOVERY, RECOVERY_MAX_ATTEMPTS, recoveryDelayMs, recoveryTargets, runPortalIntervalRecovery,
} from '../catalog-recovery.service';
import {
  duplicateIntervals, ensureUpgradePortalConfiguration, portalProductsFor, syncUpgradePortal, acceptedProducts,
} from '../portal-configuration.service';
import { manifestRevision } from '../pricing-manifest';
import { memoryStore, testDeps } from './helpers/fake-stripe-catalog';
import { realisticStripe, seedAccount, STRIPE_UNIQUE_INTERVALS_ERROR, type RealisticOptions } from './helpers/realistic-stripe';

const CTX = 'test:preprod';
const ACCT = 'acct_1SX8QQL7bbQ8HKBX';
const MANIFEST = [390, 3900, 690, 6900, 990, 9900];
const OLD_ERROR = 'unexpected: For each product, its price must have unique billing intervals.';
const T0 = new Date();

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
const creates = () => rs.calls.filter((c) => c === 'prices.create').length;
const keyUpdates = () => rs.calls.filter((c) => c.startsWith('prices.update')).length;
const newPrices = () => [...rs.prices.values()].filter((p) => p.id.startsWith('price_new_'));
const isNew = (products: Array<{ prices: string[] }>) => products.some((p) => p.prices.some((id) => id.startsWith('price_new_')));
const isOld = (products: Array<{ prices: string[] }>) => products.some((p) => p.prices.some((id) => id.startsWith('price_seed_')));
const portalConf = () => [...rs.portal.values()][0];
const intervalsOf = (products: Array<{ product: string; prices: string[] }>) =>
  products.flatMap((p) => p.prices.map((id) => ({ productId: p.product, priceId: id, interval: rs.prices.get(id)?.recurring?.interval ?? '?' })));
const fixedProbe = async () => 'subs-unchanged';

/**
 * Reconstruit l'incident préprod : grille V2 vendue (ancien seed), reprise
 * historique terminée, publication automatique dont le portail est refusé
 * par Stripe sur l'UNION (comportement de l'ancien code), état FAILED.
 */
async function incident(env: Record<string, string> = {}, opts: RealisticOptions = {}) {
  deploy(seedAccount(), env, opts);
  await tick(); // révision V2 adoptée, portail créé avec les six anciens prix
  await store.setBackfillCompleted(CTX, new Date());
  at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
  rs.opts.portalFail = (_n, products) => (isNew(products) ? 'intervals' : null);
  const r = await runCatalogPublishTask();
  expect(r.error).toMatch(/publication en échec/);
  rs.opts.portalFail = undefined;
  // Format EXACT journalisé par l'ancien code (étape « unexpected »).
  store.states.get(CTX)!.publicationError = OLD_ERROR;
  const st = store.states.get(CTX)!;
  expect(st.publicationState).toBe('FAILED');
  expect(newPrices()).toHaveLength(6);
  // Clés déjà transférées aux nouveaux prix, ancienne grille toujours vendue.
  for (const c of CATALOG_COUPLES) expect([...rs.prices.values()].find((p) => p.lookup_key === c.lookupKey)!.id).toMatch(/^price_new_/);
  expect(st.activeSnapshot!.entries['standard:monthly']!.unitAmountCents).toBe(290);
  return { runId: st.publicationRunId!, runs: store.runs.length, creates: creates() };
}

async function expectManifestPublished() {
  forgetCatalogMemory();
  const p = await getPublicCatalog(t.deps);
  expect(p).toMatchObject({ status: 'ok', purchasable: true, reason: null });
  expect(p.offers.map((o) => o.unit_amount_cents)).toEqual(MANIFEST);
  expect(p.offers.every((o) => o.tax_included)).toBe(true);
  for (const c of CATALOG_COUPLES) {
    const r = await resolveCurrentPrice(c.planCode, c.billingPeriod, { forPayment: true }, t.deps);
    expect(r).toMatchObject({ taxBehavior: 'inclusive', lookupKey: c.lookupKey, unitAmountCents: EXPECTED_V4_GRID[c.planCode][c.billingPeriod] });
    expect(rs.prices.get(r.priceId)!.lookup_key).toBe(c.lookupKey);
  }
  const st = (await store.getState(CTX))!;
  expect(st).toMatchObject({ publicationState: 'ACTIVE', publicationError: null, publishedManifestRevision: manifestRevision() });
}

beforeEach(() => {
  campaigns.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ─── Portail : jamais deux prix de même périodicité pour un produit ─────────

describe('portail — six prix candidats exactement', () => {
  it('AC-L49A-1 — le faux Stripe reproduit l’erreur réelle sur l’union ancienne + nouvelle révision', async () => {
    deploy(seedAccount());
    await tick();
    const id = portalConf().id;
    await expect(rs.client.billingPortal.configurations.update(id, { features: { subscription_update: { products: [{ product: 'prod_seed_std', prices: ['price_seed_std_m', 'price_seed_std_y', 'price_seed_pre_m'] }] } } } as never))
      .rejects.toThrow(/belong/);
    rs.prices.set('price_x_m', { ...rs.prices.get('price_seed_std_m')!, id: 'price_x_m' });
    await expect(rs.client.billingPortal.configurations.update(id, { features: { subscription_update: { products: [{ product: 'prod_seed_std', prices: ['price_seed_std_m', 'price_x_m'] }] } } } as never))
      .rejects.toThrow(STRIPE_UNIQUE_INTERVALS_ERROR);
  });

  it('AC-L49A-1 — publication sous les MÊMES produits : portail jamais appelé avec un doublon, exactement les six nouveaux prix', async () => {
    deploy(seedAccount());
    await tick();
    await store.setBackfillCompleted(CTX, new Date());
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    expect((await runCatalogPublishTask()).note).toMatch(/publication : published/);
    await expectManifestPublished();
    for (const w of rs.portalWrites) {
      expect(w.accepted).toBe(true);
      expect(duplicateIntervals(intervalsOf(w.products))).toEqual([]);
    }
    const accepted = acceptedProducts(portalConf());
    expect(accepted.flatMap((p) => p.prices).sort()).toEqual(newPrices().map((p) => p.id).sort());
    expect(accepted).toHaveLength(3);
    expect(accepted.every((p) => p.prices.length === 2)).toBe(true);
    // Paramètres du parcours de montée en gamme relus.
    expect(portalConf().features.subscription_update).toMatchObject({ enabled: true, proration_behavior: 'always_invoice', default_allowed_updates: ['price'] });
    // Anciens Price actifs, reconnus au registre (abonnés existants intacts).
    expect(rs.prices.get('price_seed_std_m')).toMatchObject({ active: true, lookup_key: null });
    expect(await store.findPriceVersion(CTX, 'price_seed_std_m')).toMatchObject({ unitAmountCents: 290 });
    // Contrôles après activation enregistrés au journal.
    const run = store.runs[store.runs.length - 1];
    expect((run.report as { checks: { ok: boolean } }).checks.ok).toBe(true);
  });

  it('AC-L49A-1 — doublon de périodicité détecté AVANT tout appel Stripe (portail non modifié)', async () => {
    deploy(seedAccount());
    await tick();
    const writes = rs.portalWrites.length;
    const st = (await store.getState(CTX))!;
    const snap = JSON.parse(JSON.stringify(st.activeSnapshot));
    // Deux mensuels sous le même produit.
    snap.entries['premium:monthly'] = { ...snap.entries['premium:monthly'], productId: snap.entries['standard:monthly'].productId };
    await expect(syncUpgradePortal({ reason: 'test', snapshot: snap, persist: false }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_DUPLICATE_INTERVAL' });
    expect(rs.portalWrites.length).toBe(writes);
    expect(t.anomalies.some((a) => a.fingerprint === `stripe:catalog:${CTX}:portal`)).toBe(true);
  });

  it('AC-L49A-1 — grille incomplète refusée à la publication (exactement six prix)', async () => {
    deploy(seedAccount());
    await tick();
    const snap = JSON.parse(JSON.stringify((await store.getState(CTX))!.activeSnapshot));
    delete snap.entries['premium_duo:yearly'];
    await expect(syncUpgradePortal({ reason: 'test', snapshot: snap, persist: false, requireComplete: true }, t.deps)).rejects.toMatchObject({ code: 'PORTAL_INCOMPLETE' });
  });
});

// ─── Échec avant activation : restauration, blocage des upgrades ────────────

describe('sécurisation de l’activation et retour arrière du portail', () => {
  it('AC-L49A-4 — échec du portail avant activation : ancienne révision active, portail restauré et vérifié, upgrades possibles', async () => {
    deploy(seedAccount());
    await tick();
    await store.setBackfillCompleted(CTX, new Date());
    const oldProducts = acceptedProducts(portalConf());
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    rs.opts.portalFail = (_n, products) => (isNew(products) ? 'invalid' : null);
    const r = await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    expect(r).toMatchObject({ status: 'failed', step: 'portal', transient: false });
    const st = (await store.getState(CTX))!;
    expect(st.publicationState).toBe('FAILED');
    expect(st.activeSnapshot!.entries['standard:monthly']!.unitAmountCents).toBe(290);
    expect(acceptedProducts(portalConf())).toEqual(oldProducts);
    expect(store.runs[store.runs.length - 1].steps.map((s) => s.step)).toEqual(expect.arrayContaining(['portal-backup', 'portal-restored']));
    // Pendant l'échec : clic en LECTURE SEULE, portail = révision active → parcours ouvert.
    const writes = rs.portalWrites.length;
    await expect(ensureUpgradePortalConfiguration(t.deps)).resolves.toBe(portalConf().id);
    expect(rs.portalWrites.length).toBe(writes);
    expect(newPrices().every((p) => p.active)).toBe(true);
  });

  it('AC-L49A-4 — restauration impossible : anomalie explicite et montées en gamme BLOQUÉES (« réessayez »)', async () => {
    deploy(seedAccount());
    await tick();
    await store.setBackfillCompleted(CTX, new Date());
    at(AUTO_PUBLISH_DELAY_MS / 60_000 + 1);
    // Le portail accepte les six candidats, puis l'activation en base échoue et la restauration aussi.
    rs.opts.portalFail = (_n, products) => (isOld(products) ? 'transient' : null);
    const activate = store.activateSnapshot.bind(store);
    store.activateSnapshot = async () => { throw new Error('base indisponible'); };
    const r = await publishCodeCatalog({ trigger: 'manual' }, t.deps);
    store.activateSnapshot = activate;
    expect(r.status).toBe('failed');
    expect((r as { reason: string }).reason).toMatch(/portail NON restauré.*montées en gamme bloquées/);
    expect(t.anomalies.some((a) => a.fingerprint === `stripe:catalog:${CTX}:portal-restore`)).toBe(true);
    expect((await store.getState(CTX))!.publicationState).toBe('FAILED');
    const writes = rs.portalWrites.length;
    await expect(ensureUpgradePortalConfiguration(t.deps)).rejects.toMatchObject({ code: 'PORTAL_UPDATING' });
    // Le clic n'écrit jamais le portail pendant la transition.
    expect(rs.portalWrites.length).toBe(writes);
  });

  it('AC-L49A-4 — révision ACTIVE : le clic aligne et vérifie le portail (comportement inchangé)', async () => {
    deploy(seedAccount());
    await tick();
    const id = await ensureUpgradePortalConfiguration(t.deps);
    expect(id).toBe(portalConf().id);
    expect(acceptedProducts(portalConf())).toEqual(portalProductsFor((await store.getState(CTX))!.activeSnapshot!));
  });
});

// ─── Rattrapage ciblé de l'incident ─────────────────────────────────────────

describe('rattrapage automatique de la publication préprod en échec', () => {
  it('AC-L49A-7 — après déploiement, la tâche interne résout l’incident sans action : grille V4 cohérente partout', async () => {
    const inc = await incident();
    at(40);
    const r = await runCatalogPublishTask();
    expect(r.error).toBeUndefined();
    expect(r.note).toMatch(/rattrapage : done/);
    await expectManifestPublished();
    // Même publication, mêmes prix : ni nouvelle exécution, ni nouveau Price.
    expect(store.runs).toHaveLength(inc.runs);
    expect(creates()).toBe(inc.creates);
    expect(newPrices()).toHaveLength(6);
    const run = store.runs[inc.runId - 1];
    expect(run.state).toBe('ACTIVE');
    expect(run.steps.map((s) => s.step)).toEqual(expect.arrayContaining(['resume', 'portal-backup', 'portal-candidate', 'activated', 'portal-final']));
    // Portail : exclusivement les six prix actifs.
    expect(acceptedProducts(portalConf()).flatMap((p) => p.prices).sort()).toEqual(newPrices().map((p) => p.id).sort());
    // Aucune revalorisation, aucun envoi ; anciens prix actifs et reconnus.
    expect(campaigns).toHaveLength(0);
    expect(run.steps.find((s) => s.step === 'revaluation-campaign')).toMatchObject({ skipped: expect.any(String) });
    expect(rs.calls.some((c) => c.startsWith('subscriptions.update') || c.startsWith('subscriptionSchedules'))).toBe(false);
    expect(rs.prices.get('price_seed_pre_y')).toMatchObject({ active: true });
    // Rattrapage enregistré comme terminé, anomalie de publication résolue.
    const row = (await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!;
    expect(row).toMatchObject({ status: 'DONE', attempts: 1, runId: inc.runId, lastError: null });
    expect(row.report).toMatchObject({ subscriptionsUnchanged: true, revaluation: 'aucune', checks: { ok: true } });
    const checks = (row.report as { checks: { couples: Array<{ unitAmountCents: number; taxBehavior: string; ok: boolean }> } }).checks;
    expect(checks.couples.map((c) => c.unitAmountCents)).toEqual(MANIFEST);
    expect(checks.couples.every((c) => c.taxBehavior === 'inclusive' && c.ok)).toBe(true);
    expect(t.resolved).toContain(`stripe:catalog:${CTX}:publication`);
    // Passages suivants : plus rien (pas de boucle, pas de reprise générale).
    const calls = rs.calls.length;
    at(50);
    expect((await runCatalogPublishTask()).note).toMatch(/aucune publication \(ALREADY_PUBLISHED\)/);
    expect(rs.calls.length).toBe(calls);
  });

  it('AC-L49A-2 — publication échouée après transferts PARTIELS : reprise sans duplication de Price, seuls les transferts manquants', async () => {
    const inc = await incident();
    // Deux clés encore sur les anciens prix (transferts non faits).
    await rs.client.prices.update('price_seed_std_m', { lookup_key: 'verebona_standard_monthly', transfer_lookup_key: true });
    await rs.client.prices.update('price_seed_duo_y', { lookup_key: 'verebona_premium_duo_yearly', transfer_lookup_key: true });
    const before = keyUpdates();
    at(40);
    const r = await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe });
    expect(r.status).toBe('done');
    expect(keyUpdates() - before).toBe(2);
    expect(creates()).toBe(inc.creates);
    const transfers = store.runs[inc.runId - 1].transfers;
    expect(transfers.filter((x) => x.already)).toHaveLength(4);
    await expectManifestPublished();
  });

  it('AC-L49A-2 — candidat journalisé introuvable : échec fonctionnel visible, AUCUN Price créé', async () => {
    const inc = await incident();
    const lost = store.runs[inc.runId - 1].createdPrices.verebona_premium_monthly as string;
    rs.prices.delete(lost);
    at(40);
    const r = await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe });
    expect(r.status).toBe('failed');
    expect(creates()).toBe(inc.creates);
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.status).toBe('FAILED');
  });

  it('AC-L49A-3 — deux instances simultanées : une seule reprise', async () => {
    const inc = await incident();
    at(40);
    const [a, b] = await Promise.all([
      runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe }),
      runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['done', 'skipped']);
    expect([a, b].find((x) => x.status === 'skipped')).toMatchObject({ reason: 'LOCKED' });
    expect(store.runs[inc.runId - 1].steps.filter((s) => s.step === 'resume')).toHaveLength(1);
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.attempts).toBe(1);
    // L'instance suivante ne refait rien.
    expect(await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'ALREADY_DONE' });
  });

  it('AC-L49A-5 — production, autre compte, erreur sans rapport : rattrapage ignoré, aucune écriture Stripe', async () => {
    // Production (live) : aucune lecture Stripe.
    await incident();
    const live = { mode: 'live' as const, appEnv: 'production', catalogContext: 'live:production' };
    const st = store.states.get(CTX)!;
    store.states.set('live:production', { ...st, catalogContext: 'live:production' });
    const calls = rs.calls.length;
    expect(await runPortalIntervalRecovery({ ...t.deps, context: () => live }, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'OUT_OF_SCOPE_CONTEXT' });
    expect(await runPortalIntervalRecovery({ ...t.deps, context: () => ({ mode: 'test', appEnv: 'production', catalogContext: 'test:production' }) })).toMatchObject({ status: 'skipped', reason: 'OUT_OF_SCOPE_CONTEXT' });
    expect(rs.calls.length).toBe(calls);

    // Autre compte Stripe.
    await incident({}, { accountId: 'acct_autre' });
    const before = rs.calls.filter((c) => !c.startsWith('prices.list') && !c.startsWith('prices.retrieve')).length;
    expect(await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'OTHER_ACCOUNT' });
    expect(rs.calls.filter((c) => !c.startsWith('prices.list') && !c.startsWith('prices.retrieve')).length).toBe(before);
    expect(await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key)).toBeNull();
    expect(store.states.get(CTX)!.publicationState).toBe('FAILED');

    // Erreur sans rapport.
    await incident();
    store.states.get(CTX)!.publicationError = 'transfer: verebona_standard_monthly: Stripe down';
    expect(await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'UNRELATED_ERROR' });
    expect(store.states.get(CTX)!.publicationState).toBe('FAILED');
  });

  it('AC-L49A-5 — ciblage pur : contexte, mode, état et erreur', () => {
    const base = { catalogContext: CTX, mode: 'test', publicationState: 'FAILED', publicationError: OLD_ERROR, publicationRunId: 3 };
    expect(recoveryTargets(base, null)).toEqual({ targeted: true, reason: 'INCIDENT' });
    expect(recoveryTargets({ ...base, catalogContext: 'live:production', mode: 'live' }, null).targeted).toBe(false);
    expect(recoveryTargets({ ...base, publicationState: 'ACTIVE' }, null).targeted).toBe(false);
    expect(recoveryTargets({ ...base, publicationError: 'portal: PORTAL_MISMATCH' }, null).targeted).toBe(false);
    // Rattrapage engagé sur la même exécution : l'erreur a pu changer (panne passagère).
    const row = { catalogContext: CTX, recoveryKey: 'k', status: 'RETRY_WAIT' as const, runId: 3, attempts: 1, lastError: 'x', lastAttemptAt: null, nextAttemptAt: null, completedAt: null, report: null };
    expect(recoveryTargets({ ...base, publicationError: 'portal: Stripe down' }, row).targeted).toBe(true);
    expect(recoveryTargets({ ...base, publicationError: 'portal: Stripe down', publicationRunId: 9 }, row).targeted).toBe(false);
  });

  it('AC-L49A-6 — arrêt explicite de publication : ni rattrapage, ni publication, ni amorçage par stripe-catalog-sync', async () => {
    await incident();
    (t.deps.env as Record<string, string>).SCHEDULED_TASK_STRIPE_CATALOG_PUBLISH = 'off';
    expect(publicationStopped(t.deps.env)).toBe(true);
    const creates0 = creates();
    at(40);
    expect(await runPortalIntervalRecovery(t.deps)).toMatchObject({ status: 'skipped', reason: 'PUBLICATION_STOPPED' });
    expect((await runCatalogPublishTask()).note).toMatch(/PUBLICATION_STOPPED/);
    expect(store.states.get(CTX)!.publicationState).toBe('FAILED');
    expect(await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key)).toBeNull();

    // Amorçage (aucune grille vendable) : l'arrêt s'applique aussi au chemin `stripe-catalog-sync`.
    deploy(seedAccount({ archived: true }), { SCHEDULED_TASK_STRIPE_CATALOG_PUBLISH: 'off' });
    await tick();
    expect(creates()).toBe(0);
    expect((await store.getState(CTX))!.publishedManifestRevision).toBeNull();
    expect(await runAutoPublication(t.deps, { onlyBootstrap: true })).toMatchObject({ decision: { publish: false, reason: 'PUBLICATION_STOPPED' } });
    expect(creates0).toBeGreaterThan(0);
  });

  it('AC-L49A-7 — panne Stripe passagère : reprises espacées et bornées, puis échec visible sans boucle', async () => {
    await incident();
    rs.opts.portalFail = (_n, products) => (isNew(products) ? 'transient' : null);
    let minute = 40;
    for (let i = 1; i <= RECOVERY_MAX_ATTEMPTS; i++) {
      at(minute);
      const r = await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe });
      const row = (await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!;
      expect(row.attempts).toBe(i);
      if (i < RECOVERY_MAX_ATTEMPTS) {
        expect(r.status).toBe('retry_wait');
        expect(row.status).toBe('RETRY_WAIT');
        // Avant l'échéance : aucune tentative.
        expect(await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'retry_wait' });
        expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.attempts).toBe(i);
        minute += recoveryDelayMs(i) / 60_000 + 1;
      } else {
        expect(r.status).toBe('failed');
        expect(row.status).toBe('FAILED');
        expect(row.lastError).toMatch(/tentatives épuisées/);
      }
    }
    expect(store.states.get(CTX)!.publicationState).toBe('FAILED');
    expect(store.states.get(CTX)!.activeSnapshot!.entries['standard:monthly']!.unitAmountCents).toBe(290);
    at(minute + 600);
    expect(await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'skipped', reason: 'RECOVERY_FAILED' });
    expect(t.anomalies.some((a) => a.fingerprint === `stripe:catalog:${CTX}:recovery:${PORTAL_INTERVAL_RECOVERY.key}`)).toBe(true);
  });

  it('AC-L49A-7 — erreur fonctionnelle persistante : une seule tentative, erreur exploitable, plus aucune reprise', async () => {
    await incident();
    rs.opts.portalFail = (_n, products) => (isNew(products) ? 'invalid' : null);
    at(40);
    const r = await runCatalogPublishTask();
    expect(r.error).toMatch(/rattrapage de la publication en échec/);
    const row = (await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!;
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(row.lastError).toMatch(/portal/);
    at(90);
    expect((await runCatalogPublishTask()).error).toBeUndefined();
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.attempts).toBe(1);
  });

  it('AC-L49A-7 — préconditions : reprise historique non terminée → attente sans écriture ; produits non approuvés → échec visible', async () => {
    await incident();
    store.states.get(CTX)!.backfillCompletedAt = null;
    at(40);
    const writes = keyUpdates();
    expect(await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'waiting' });
    expect(keyUpdates()).toBe(writes);
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!).toMatchObject({ status: 'WAITING', attempts: 0 });
    store.states.get(CTX)!.backfillCompletedAt = new Date();
    store.products.set(CTX, store.products.get(CTX)!.filter((p) => p.planCode !== 'premium'));
    expect(await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'failed' });
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.lastError).toMatch(/produit de vente non approuvé \(premium\)/);
  });

  it('AC-L49A-7 — amorçage (grille vendue partielle, manifeste jamais publié) : reprise historique non exigée, comme la première publication', async () => {
    await incident();
    const st = store.states.get(CTX)!;
    st.backfillCompletedAt = null;
    delete st.activeSnapshot!.entries['premium_duo:yearly'];
    at(40);
    expect(await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: fixedProbe })).toMatchObject({ status: 'done' });
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.report).toMatchObject({ backfill: 'non exigée (amorçage)' });
  });

  it('AC-L49A-7 — abonnements existants modifiés pendant la reprise : contrôle en écart signalé', async () => {
    await incident();
    at(40);
    let n = 0;
    const r = await runPortalIntervalRecovery(t.deps, { subscriptionsProbe: async () => `h${n++}` });
    expect(r.status).toBe('failed');
    expect((await store.getRecovery(CTX, PORTAL_INTERVAL_RECOVERY.key))!.status).toBe('CHECK_FAILED');
    // La grille est néanmoins active et cohérente.
    await expectManifestPublished();
  });

  it('AC-L49A-7 — montants attendus de la grille V4 = manifeste du code', () => {
    expect(CATALOG_COUPLES.map((c) => EXPECTED_V4_GRID[c.planCode][c.billingPeriod])).toEqual(MANIFEST);
    expect(coupleKey('standard', 'monthly')).toBe('standard:monthly');
    expect(recoveryDelayMs(1)).toBe(10 * 60_000);
    expect(recoveryDelayMs(3)).toBe(40 * 60_000);
  });
});
