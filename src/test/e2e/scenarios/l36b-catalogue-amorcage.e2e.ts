/**
 * Lot 36B — « Tarif indisponible » partout après le lot 35 : amorçage du
 * catalogue Stripe sur base PostgreSQL RÉELLE (magasin `pgCatalogStore`,
 * verrous `job_locks`, migration 0306), compte Stripe simulé réaliste
 * (aucun appel réseau), tâches planifiées réelles, catalogue public final.
 *
 * Scénarios (a) ancien seed, (b) prix manuels + variables V1, (c) aucune
 * variable, (d) STRIPE_EXPECTED_MODE absente. La reprise historique est
 * simulée bloquée (cas préprod : abonnés de test non rapprochables).
 * Chaque scénario a son propre contexte de catalogue (aucun mélange, LK-02).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { scenario } from '../scenario';
import { uid } from '../factories';
import { manualAccount, realisticStripe, seedAccount, v1Env } from '@/services/billing/__tests__/helpers/realistic-stripe';

vi.mock('@/services/billing/price-backfill.service', () => ({
  CURRENT_STRIPE_STATUSES: new Set(['active']),
  runPriceBackfill: async () => ({ references: 2, recognized: 0, unknown: ['price_x'], inconsistent: [], unavailable: [], contractsEnriched: 0, schedulesEnriched: 0, schedulesBlocked: 0, multiItemSubscriptions: [], foreignSubscriptions: 0, blocking: 2, completed: false }),
}));
vi.mock('@/services/billing/price-revaluation.service', async (orig) => ({
  ...(await orig<typeof import('@/services/billing/price-revaluation.service')>()),
  createRevaluationCampaign: async () => ({ inventoried: 0, planned: 0, deferred: 0, excluded: 0, skippedSamePrice: 0 }),
}));

const MANIFEST = [390, 3900, 690, 6900, 990, 9900];

scenario('L36B', 'Catalogue Stripe : amorçage automatique jusqu’au catalogue public', ({ sql }) => {
  let plansBefore: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('STRIPE_PRICE_')) delete process.env[k];
    plansBefore = await sql`SELECT code, monthly_price_cents, yearly_price_cents, stripe_price_id_monthly, stripe_price_id_yearly FROM subscription_plans`;
  });
  afterAll(async () => {
    const { __setCatalogDepsForTests } = await import('@/services/billing/price-catalog.service');
    __setCatalogDepsForTests(null);
    // Miroirs `subscription_plans` rendus à l'état initial (scénarios suivants).
    for (const p of plansBefore) {
      await sql`UPDATE subscription_plans SET monthly_price_cents = ${p.monthly_price_cents as number}, yearly_price_cents = ${p.yearly_price_cents as number},
        stripe_price_id_monthly = ${p.stripe_price_id_monthly as string}, stripe_price_id_yearly = ${p.stripe_price_id_yearly as string} WHERE code = ${p.code as string}`;
    }
  });

  async function deploy(account: { prices: Stripe.Price[]; products: Stripe.Product[] }, env: Record<string, string>) {
    const svc = await import('@/services/billing/price-catalog.service');
    const ctx = `test:l36b-${uid('c')}`;
    const rs = realisticStripe(account.prices, account.products);
    svc.__setCatalogDepsForTests({
      stripe: () => rs.client,
      context: () => ({ mode: 'test', appEnv: 'preprod', catalogContext: ctx }),
      env: env as unknown as NodeJS.ProcessEnv,
      anomalies: { report: async () => undefined, resolve: async () => undefined },
    });
    return { ctx, rs, svc };
  }

  async function tickUntilOk() {
    const { runCatalogSyncTask } = await import('@/services/billing/catalog-tasks');
    return runCatalogSyncTask({ trigger: 'schedule', deadline: Date.now() + 60_000 });
  }

  async function expectOk(ctx: string, svc: typeof import('@/services/billing/price-catalog.service'), amounts = MANIFEST) {
    svc.forgetCatalogMemory();
    const pub = await svc.getPublicCatalog();
    expect(pub).toMatchObject({ status: 'ok', purchasable: true, reason: null, unavailable: [] });
    expect(pub.offers.map((o) => o.unit_amount_cents)).toEqual(amounts);
    expect(JSON.stringify(pub)).not.toMatch(/(price|prod)_(seed|man|new|v1)/);
    // Quotas lus en base réelle (référentiel d'offres).
    expect(pub.plans.length).toBeGreaterThan(0);
    return (await sql`SELECT * FROM stripe_catalog_state WHERE catalog_context = ${ctx}`)[0];
  }

  it('AC-c — aucune variable, prix manuels sans clé : première publication au premier passage, 6 offres du manifeste', async () => {
    const { ctx, rs, svc } = await deploy(manualAccount(), { STRIPE_EXPECTED_MODE: 'test' });
    const r = await tickUntilOk();
    expect(r.note).toMatch(/première publication : published/);
    const st = await expectOk(ctx, svc);
    expect(st).toMatchObject({ publication_state: 'ACTIVE', previous_snapshot: null });
    expect(st.published_manifest_revision).toMatch(/^mf_/);
    expect((await sql`SELECT count(*)::int AS n FROM stripe_catalog_products WHERE catalog_context = ${ctx} AND role = 'sale'`)[0].n).toBe(3);
    expect((await sql`SELECT state, trigger FROM stripe_catalog_runs WHERE catalog_context = ${ctx} AND kind = 'publish'`)).toEqual([{ state: 'ACTIVE', trigger: 'auto' }]);
    expect(rs.calls.filter((c) => c === 'prices.create')).toHaveLength(6);
    // Relance : idempotente.
    await tickUntilOk();
    expect(rs.calls.filter((c) => c === 'prices.create')).toHaveLength(6);
  });

  it('AC-b — prix manuels, variables V1 seulement : produits configurés réutilisés, 6 offres du manifeste', async () => {
    const { ctx, rs, svc } = await deploy(manualAccount({ legacyAnnual: true }), { STRIPE_EXPECTED_MODE: 'test', ...v1Env() });
    await tickUntilOk();
    await expectOk(ctx, svc);
    expect(rs.calls).not.toContain('products.create');
    const sources = await sql`SELECT stripe_product_id, source FROM stripe_catalog_products WHERE catalog_context = ${ctx} AND role = 'sale' ORDER BY plan_code`;
    expect(sources.map((x) => x.stripe_product_id).sort()).toEqual(['prod_man_duo', 'prod_man_pre', 'prod_man_std']);
  });

  it('AC-a — ancien seed : grille vendue adoptée telle quelle (« ok », 6 offres), aucune publication prématurée', async () => {
    const { ctx, rs, svc } = await deploy(seedAccount(), { STRIPE_EXPECTED_MODE: 'test' });
    await tickUntilOk();
    const st = await expectOk(ctx, svc, [290, 2900, 590, 5900, 890, 8900]);
    expect(st.published_manifest_revision).toBeNull();
    expect(rs.calls).not.toContain('prices.create');
    expect((await sql`SELECT source FROM stripe_catalog_products WHERE catalog_context = ${ctx} AND role = 'sale'`).map((x) => x.source)).toEqual(Array(3).fill('bootstrap:product-metadata'));
  });

  it('AC-d — STRIPE_EXPECTED_MODE absente, NEXT_PUBLIC_APP_ENV=preprod : publication permise', async () => {
    const { ctx, svc } = await deploy({ prices: [], products: [] }, { NEXT_PUBLIC_APP_ENV: 'preprod' });
    await tickUntilOk();
    await expectOk(ctx, svc);
  });
});
