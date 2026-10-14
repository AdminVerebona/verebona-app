/**
 * Lot 53I — BUG P1 Stripe : reprise automatique de la publication tarifaire
 * bloquée en préproduction, sur base PostgreSQL RÉELLE (magasin
 * `pgCatalogStore`, `stripe_catalog_recoveries`, verrous `job_locks`,
 * empreinte réelle des abonnements, tâches planifiées réelles, route
 * GET /api/billing/catalog, diagnostic BO).
 *
 * Compte Stripe simulé FIDÈLE à l'API 2025-08-27.basil : la liste des prix
 * autorisés du portail (`features.subscription_update.products`, champ
 * includable) n'est renvoyée qu'avec `expand` — cause de l'incident
 * (« PORTAL_MISMATCH : prix acceptés ∅ » puis « PORTAL_RESTORE_FAILED »).
 * Aucun appel réseau.
 *
 * État préprod reconstitué : publication FAILED (erreur exacte), rattrapage
 * 49A FAILED après 1/5, six nouveaux Price existants (clés déjà
 * transférées), quatre abonnements historiques aux anciens prix.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { realisticStripe, seedAccount } from '@/services/billing/__tests__/helpers/realistic-stripe';

vi.mock('@/services/billing/price-revaluation.service', async (orig) => ({
  ...(await orig<typeof import('@/services/billing/price-revaluation.service')>()),
  createRevaluationCampaign: async () => { throw new Error('aucune campagne ne doit être créée par la reprise'); },
}));

const CTX = 'test:preprod';
const ACCT = 'acct_1SX8QQL7bbQ8HKBX';
const MANIFEST = [390, 3900, 690, 6900, 990, 9900];

scenario('L53', 'Stripe : reprise automatique de la publication tarifaire bloquée (portail relu avec expansion)', ({ sql, make }) => {
  let plansBefore: Array<Record<string, unknown>> = [];
  const accounts: number[] = [];

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
    vi.unstubAllEnvs();
    await cleanup();
    if (accounts.length) await sql`UPDATE account_subscriptions SET stripe_subscription_id = NULL WHERE account_id = ANY(${accounts})`;
    for (const p of plansBefore) {
      await sql`UPDATE subscription_plans SET monthly_price_cents = ${p.monthly_price_cents as number}, yearly_price_cents = ${p.yearly_price_cents as number},
        stripe_price_id_monthly = ${p.stripe_price_id_monthly as string}, stripe_price_id_yearly = ${p.stripe_price_id_yearly as string} WHERE code = ${p.code as string}`;
    }
  });

  it('STRIPE-P1-50 — état préprod reconstitué → passage de la tâche : publication ACTIVE, six clés conformes, /api/billing/catalog = nouvelle grille, abonnements inchangés ; second passage sans effet', async () => {
    vi.stubEnv('STRIPE_EXPECTED_MODE', 'test');
    const svc = await import('@/services/billing/price-catalog.service');
    const { runCatalogSyncTask, runCatalogPublishTask } = await import('@/services/billing/catalog-tasks');
    const { PORTAL_INTERVAL_RECOVERY, PORTAL_PRODUCTS_RECOVERY } = await import('@/services/billing/catalog-recovery.service');
    const { manifestRevision } = await import('@/services/billing/pricing-manifest');
    const { getCatalogDiagnostic } = await import('@/services/billing/catalog-diagnostic.service');
    const { GET } = await import('@/app/api/billing/catalog/route');
    const account = seedAccount();
    const rs = realisticStripe(account.prices, account.products, { accountId: ACCT });
    svc.__setCatalogDepsForTests({
      stripe: () => rs.client,
      context: () => ({ mode: 'test', appEnv: 'preprod', catalogContext: CTX }),
      env: { STRIPE_EXPECTED_MODE: 'test' } as unknown as NodeJS.ProcessEnv,
      anomalies: { report: async () => undefined, resolve: async () => undefined },
    });

    // ── Grille V2 vendue, reprise historique terminée, code en service depuis 30 min ──
    await runCatalogSyncTask({ trigger: 'schedule', deadline: Date.now() + 60_000 });
    await sql`UPDATE stripe_catalog_state SET backfill_completed_at = now(), candidate_first_seen_at = now() - interval '30 minutes' WHERE catalog_context = ${CTX}`;

    // ── Quatre abonnements historiques aux anciens prix (tarif contractuel) ──
    const subs: Array<[string, 'standard' | 'premium' | 'premium_duo', 'monthly' | 'yearly', string, number]> = [
      ['sub_e2e_std_m', 'standard', 'monthly', 'price_seed_std_m', 290],
      ['sub_e2e_pre_m', 'premium', 'monthly', 'price_seed_pre_m', 590],
      ['sub_e2e_pre_y', 'premium', 'yearly', 'price_seed_pre_y', 5900],
      ['sub_e2e_duo_y', 'premium_duo', 'yearly', 'price_seed_duo_y', 8900],
    ];
    for (const [subId, plan, period, priceId, amount] of subs) {
      const a = await make.account({ plan });
      accounts.push(a.id);
      await sql`UPDATE account_subscriptions SET stripe_subscription_id = ${subId}, stripe_price_id = ${priceId}, contract_unit_amount_cents = ${amount},
        billing_period = ${period}, current_period_end_at = now() + interval '20 days' WHERE account_id = ${a.id}`;
    }
    const subsSnapshot = async () => sql`SELECT account_id, stripe_subscription_id, stripe_price_id, contract_unit_amount_cents, current_period_end_at, plan_code, billing_period, status
      FROM account_subscriptions WHERE account_id = ANY(${accounts}) ORDER BY account_id`;
    const subsBefore = JSON.stringify(await subsSnapshot());

    // ── Incident d'origine : portail refusé sur l'union → FAILED, six Price créés, clés transférées ──
    rs.opts.portalFail = (_n, products) => (products.some((p) => p.prices.some((id) => id.startsWith('price_new_'))) ? 'intervals' : null);
    expect((await runCatalogPublishTask()).error).toMatch(/publication en échec/);
    rs.opts.portalFail = undefined;
    const creates = rs.calls.filter((c) => c === 'prices.create').length;
    expect(creates).toBe(6);
    const keyUpdates = rs.calls.filter((c) => c.startsWith('prices.update')).length;
    const [failed] = await sql`SELECT publication_run_id FROM stripe_catalog_state WHERE catalog_context = ${CTX}`;
    const runId = Number(failed.publication_run_id);

    // ── Résultat de l'ancien rattrapage 49A en préprod (erreur exacte, 1/5) ──
    const cfg = [...rs.portal.values()][0].id;
    const preprodError = `portal: PORTAL_MISMATCH: portail ${cfg} : prix acceptés ∅ ≠ attendus price_new_1,price_new_2,price_new_3,price_new_4,price_new_5,price_new_6 ; portail NON restauré (PORTAL_RESTORE_FAILED: PORTAL_MISMATCH: portail ${cfg} : prix acceptés ∅ ≠ attendus price_seed_duo_m,price_seed_duo_y,price_seed_pre_m,price_seed_pre_y,price_seed_std_m,price_seed_std_y) : montées en gamme bloquées`;
    await sql`UPDATE stripe_catalog_state SET publication_state = 'FAILED', publication_error = ${preprodError.slice(0, 500)} WHERE catalog_context = ${CTX}`;
    await sql`INSERT INTO stripe_catalog_recoveries (catalog_context, recovery_key, status, run_id, attempts, last_error, last_attempt_at)
      VALUES (${CTX}, ${PORTAL_INTERVAL_RECOVERY.key}, 'FAILED', ${runId}, 1, ${preprodError}, now() - interval '1 hour')`;

    // ── BO avant reprise : échec définitif 49A, reprise lot 53 en attente, aucune « action inutile » ──
    const before = await getCatalogDiagnostic();
    expect(before.recoveries.find((r) => r.key === PORTAL_INTERVAL_RECOVERY.key)!.display).toMatchObject({ phase: 'failed', actionRequired: true });
    expect(before.recoveries.find((r) => r.key === PORTAL_PRODUCTS_RECOVERY.key)!.display).toMatchObject({ phase: 'pending' });
    expect(before.couples.map((c) => c.status)).toEqual(Array(6).fill('pending_publication'));

    // ── Passage de la tâche (déploiement du correctif) ──
    const task = await runCatalogPublishTask();
    expect(task.error).toBeUndefined();
    expect(task.note).toMatch(new RegExp(`rattrapage ${PORTAL_PRODUCTS_RECOVERY.key} : done`));

    const [st] = await sql`SELECT publication_state, publication_error, published_manifest_revision, active_snapshot, previous_snapshot FROM stripe_catalog_state WHERE catalog_context = ${CTX}`;
    expect(st).toMatchObject({ publication_state: 'ACTIVE', publication_error: null, published_manifest_revision: manifestRevision() });
    const active = st.active_snapshot as { entries: Record<string, { priceId: string; unitAmountCents: number }> };
    expect(Object.values(active.entries).map((e) => e.unitAmountCents).sort((a, b) => a - b)).toEqual([...MANIFEST].sort((a, b) => a - b));
    expect(Object.values(active.entries).every((e) => e.priceId.startsWith('price_new_'))).toBe(true);
    expect((st.previous_snapshot as { entries: Record<string, { unitAmountCents: number }> }).entries['standard:monthly'].unitAmountCents).toBe(290);

    // Reprise tracée comme terminée, contrôles réussis ; 49A conservé (historique).
    const recs = await sql`SELECT recovery_key, status, attempts, run_id, report FROM stripe_catalog_recoveries WHERE catalog_context = ${CTX} ORDER BY recovery_key`;
    const r53 = recs.find((r) => r.recovery_key === PORTAL_PRODUCTS_RECOVERY.key)!;
    expect(r53).toMatchObject({ status: 'DONE', attempts: 1 });
    expect(Number(r53.run_id)).toBe(runId);
    expect(r53.report).toMatchObject({ checks: { ok: true }, subscriptionsUnchanged: true, pricesCreated: 0, portalFinal: { ok: true } });
    expect(recs.find((r) => r.recovery_key === PORTAL_INTERVAL_RECOVERY.key)).toMatchObject({ status: 'FAILED', attempts: 1 });

    // Même exécution, mêmes six Price, aucun transfert de clé.
    expect((await sql`SELECT count(*)::int AS n FROM stripe_catalog_runs WHERE catalog_context = ${CTX} AND kind = 'publish'`)[0].n).toBe(1);
    expect(rs.calls.filter((c) => c === 'prices.create')).toHaveLength(creates);
    expect(rs.calls.filter((c) => c.startsWith('prices.update'))).toHaveLength(keyUpdates);

    // Registre : anciens ET nouveaux prix (historique conservé).
    const versions = await sql`SELECT stripe_price_id, unit_amount_cents FROM stripe_price_versions WHERE catalog_context = ${CTX}`;
    expect(versions.filter((v) => String(v.stripe_price_id).startsWith('price_seed_'))).toHaveLength(6);
    expect(versions.filter((v) => String(v.stripe_price_id).startsWith('price_new_'))).toHaveLength(6);

    // Portail réel : exactement les six nouveaux prix, un mensuel + un annuel par produit.
    const conf = [...rs.portal.values()][0];
    const stored = conf.features.subscription_update.products ?? [];
    expect(stored).toHaveLength(3);
    expect(stored.flatMap((p) => p.prices).sort()).toEqual([...rs.prices.keys()].filter((id) => id.startsWith('price_new_')).sort());

    // GET /api/billing/catalog (vitrine, Mon compte › Offres desktop et mobile).
    svc.forgetCatalogMemory();
    const res = await GET(new NextRequest('http://localhost/api/billing/catalog'));
    const body = await res.json() as { status: string; offers: Array<{ unit_amount_cents: number; tax_included: boolean }> };
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.offers.map((o) => o.unit_amount_cents)).toEqual(MANIFEST);
    expect(body.offers.every((o) => o.tax_included)).toBe(true);

    // Miroirs (KPI) alignés.
    const mirrors = await sql`SELECT code, monthly_price_cents, yearly_price_cents FROM subscription_plans WHERE code IN ('standard','premium','premium_duo') ORDER BY code`;
    expect(mirrors.map((m) => [m.code, m.monthly_price_cents, m.yearly_price_cents])).toEqual([['premium', 690, 6900], ['premium_duo', 990, 9900], ['standard', 390, 3900]]);

    // BO : six clés « Conforme au code », publication complète, reprise « Terminé », 4 abonnés historiques reconnus.
    const diag = await getCatalogDiagnostic();
    expect(diag.couples.map((c) => c.status)).toEqual(Array(6).fill('ok'));
    expect(diag.publication.complete).toBe(true);
    expect(diag.recovery).toMatchObject({ key: PORTAL_PRODUCTS_RECOVERY.key, display: { phase: 'done' } });
    // (la base e2e est partagée : d'autres scénarios ont leurs propres abonnements)
    expect(diag.subscriptions.historical).toBeGreaterThanOrEqual(4);
    const ours = await sql`SELECT stripe_price_id FROM account_subscriptions WHERE account_id = ANY(${accounts})`;
    const known = new Set(versions.map((v) => String(v.stripe_price_id)));
    expect(ours.every((o) => known.has(String(o.stripe_price_id)))).toBe(true);

    // Abonnements historiques inchangés (tarif contractuel, échéance), aucune écriture d'abonnement.
    expect(JSON.stringify(await subsSnapshot())).toBe(subsBefore);
    expect(rs.calls.some((c) => c.startsWith('subscriptions.update'))).toBe(false);

    // ── Second passage : aucun effet ──
    const calls = rs.calls.length;
    const runsBefore = (await sql`SELECT count(*)::int AS n FROM stripe_catalog_runs WHERE catalog_context = ${CTX}`)[0].n;
    expect((await runCatalogPublishTask()).note).toMatch(/ALREADY_PUBLISHED/);
    expect(rs.calls.length).toBe(calls);
    expect((await sql`SELECT count(*)::int AS n FROM stripe_catalog_runs WHERE catalog_context = ${CTX}`)[0].n).toBe(runsBefore);
    expect((await sql`SELECT attempts FROM stripe_catalog_recoveries WHERE catalog_context = ${CTX} AND recovery_key = ${PORTAL_PRODUCTS_RECOVERY.key}`)[0].attempts).toBe(1);
  });
});
