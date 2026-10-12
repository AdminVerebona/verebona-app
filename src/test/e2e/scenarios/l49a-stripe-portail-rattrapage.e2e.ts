/**
 * Lot 49A — rattrapage automatique de la publication préprod en échec
 * (« For each product, its price must have unique billing intervals. ») sur
 * base PostgreSQL RÉELLE : magasin `pgCatalogStore`, migration 0326
 * (`stripe_catalog_recoveries`), verrous partagés `job_locks`, empreinte
 * réelle des abonnements, tâches planifiées réelles, catalogue public final.
 * Compte Stripe simulé réaliste (portail appliquant la règle d'unicité des
 * périodicités), aucun appel réseau.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { realisticStripe, seedAccount } from '@/services/billing/__tests__/helpers/realistic-stripe';

vi.mock('@/services/billing/price-revaluation.service', async (orig) => ({
  ...(await orig<typeof import('@/services/billing/price-revaluation.service')>()),
  createRevaluationCampaign: async () => { throw new Error('aucune campagne ne doit être créée par le rattrapage'); },
}));

const CTX = 'test:preprod';
const ACCT = 'acct_1SX8QQL7bbQ8HKBX';
const MANIFEST = [390, 3900, 690, 6900, 990, 9900];

scenario('L49A', 'Stripe : portail sans doublon et reprise automatique de la publication préprod en échec', ({ sql }) => {
  let plansBefore: Array<Record<string, unknown>> = [];

  const cleanup = async () => {
    await sql`DELETE FROM stripe_catalog_recoveries WHERE catalog_context = ${CTX}`;
    await sql`DELETE FROM stripe_catalog_runs WHERE catalog_context = ${CTX}`;
    await sql`DELETE FROM stripe_price_versions WHERE catalog_context = ${CTX}`;
    await sql`DELETE FROM stripe_catalog_products WHERE catalog_context = ${CTX}`;
    await sql`DELETE FROM stripe_catalog_state WHERE catalog_context = ${CTX}`;
  };

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('STRIPE_PRICE_')) delete process.env[k];
    plansBefore = await sql`SELECT code, monthly_price_cents, yearly_price_cents, stripe_price_id_monthly, stripe_price_id_yearly FROM subscription_plans`;
    await cleanup();
  });
  afterAll(async () => {
    const { __setCatalogDepsForTests } = await import('@/services/billing/price-catalog.service');
    __setCatalogDepsForTests(null);
    await cleanup();
    for (const p of plansBefore) {
      await sql`UPDATE subscription_plans SET monthly_price_cents = ${p.monthly_price_cents as number}, yearly_price_cents = ${p.yearly_price_cents as number},
        stripe_price_id_monthly = ${p.stripe_price_id_monthly as string}, stripe_price_id_yearly = ${p.stripe_price_id_yearly as string} WHERE code = ${p.code as string}`;
    }
  });

  it('AC-L49A-7 / AC-L49A-3 — incident reconstruit, résolu par la tâche interne sans action ; une seule reprise entre deux instances', async () => {
    const svc = await import('@/services/billing/price-catalog.service');
    const { runCatalogSyncTask, runCatalogPublishTask } = await import('@/services/billing/catalog-tasks');
    const { runPortalIntervalRecovery, PORTAL_INTERVAL_RECOVERY } = await import('@/services/billing/catalog-recovery.service');
    const { manifestRevision } = await import('@/services/billing/pricing-manifest');
    const account = seedAccount();
    const rs = realisticStripe(account.prices, account.products, { accountId: ACCT });
    svc.__setCatalogDepsForTests({
      stripe: () => rs.client,
      context: () => ({ mode: 'test', appEnv: 'preprod', catalogContext: CTX }),
      env: { STRIPE_EXPECTED_MODE: 'test' } as unknown as NodeJS.ProcessEnv,
      anomalies: { report: async () => undefined, resolve: async () => undefined },
    });

    // Grille V2 vendue, reprise historique terminée, code en service depuis 30 min.
    await runCatalogSyncTask({ trigger: 'schedule', deadline: Date.now() + 60_000 });
    await sql`UPDATE stripe_catalog_state SET backfill_completed_at = now(), candidate_first_seen_at = now() - interval '30 minutes' WHERE catalog_context = ${CTX}`;
    // Ancien code : portail refusé sur l'union ancienne + nouvelle révision.
    rs.opts.portalFail = (_n, products) => (products.some((p) => p.prices.some((id) => id.startsWith('price_new_'))) ? 'intervals' : null);
    expect((await runCatalogPublishTask()).error).toMatch(/publication en échec/);
    rs.opts.portalFail = undefined;
    await sql`UPDATE stripe_catalog_state SET publication_error = 'unexpected: For each product, its price must have unique billing intervals.' WHERE catalog_context = ${CTX}`;
    const [failed] = await sql`SELECT publication_state, publication_run_id FROM stripe_catalog_state WHERE catalog_context = ${CTX}`;
    expect(failed.publication_state).toBe('FAILED');
    const creates = rs.calls.filter((c) => c === 'prices.create').length;
    expect(creates).toBe(6);

    // Deux instances en même temps : verrou partagé `job_locks`.
    const [a, b] = await Promise.all([runPortalIntervalRecovery(), runPortalIntervalRecovery()]);
    expect([a.status, b.status].filter((s) => s === 'done')).toHaveLength(1);
    expect([a.status, b.status].filter((s) => s === 'skipped')).toHaveLength(1);

    const [st] = await sql`SELECT publication_state, publication_error, published_manifest_revision FROM stripe_catalog_state WHERE catalog_context = ${CTX}`;
    expect(st).toMatchObject({ publication_state: 'ACTIVE', publication_error: null, published_manifest_revision: manifestRevision() });
    const [rec] = await sql`SELECT status, attempts, run_id, report FROM stripe_catalog_recoveries WHERE catalog_context = ${CTX} AND recovery_key = ${PORTAL_INTERVAL_RECOVERY.key}`;
    expect(rec).toMatchObject({ status: 'DONE', attempts: 1 });
    expect(Number(rec.run_id)).toBe(Number(failed.publication_run_id));
    expect(rec.report).toMatchObject({ subscriptionsUnchanged: true, checks: { ok: true } });
    // Même publication, aucun Price supplémentaire.
    expect((await sql`SELECT count(*)::int AS n FROM stripe_catalog_runs WHERE catalog_context = ${CTX} AND kind = 'publish'`)[0].n).toBe(1);
    expect(rs.calls.filter((c) => c === 'prices.create')).toHaveLength(creates);
    // Portail : jamais de doublon envoyé après le correctif ; exactement six prix acceptés.
    const conf = [...rs.portal.values()][0];
    expect((conf.features.subscription_update.products ?? []).flatMap((p) => p.prices)).toHaveLength(6);

    // Catalogue public (vitrine, page Offres) et miroirs : grille V4 TTC.
    svc.forgetCatalogMemory();
    const pub = await svc.getPublicCatalog();
    expect(pub).toMatchObject({ status: 'ok', purchasable: true, reason: null });
    expect(pub.offers.map((o) => o.unit_amount_cents)).toEqual(MANIFEST);
    const mirrors = await sql`SELECT code, monthly_price_cents, yearly_price_cents FROM subscription_plans WHERE code IN ('standard','premium','premium_duo') ORDER BY code`;
    expect(mirrors.map((m) => [m.code, m.monthly_price_cents, m.yearly_price_cents])).toEqual([['premium', 690, 6900], ['premium_duo', 990, 9900], ['standard', 390, 3900]]);

    // Passage suivant de la tâche : plus rien à faire.
    const calls = rs.calls.length;
    expect((await runCatalogPublishTask()).note).toMatch(/ALREADY_PUBLISHED/);
    expect(rs.calls.length).toBe(calls);
  });
});
