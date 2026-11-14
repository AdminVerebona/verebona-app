/**
 * L109L — ticket P1 « Tarifs Gemini non reconnus, 948 appels signalés sans
 * tarif et coûts IA incomplets » (base réelle, aucun appel IA).
 *
 *   A · page officielle au format Markdoc ({% tab %}, {% table %}) lue ;
 *       empreinte / format / URL capturés ; page HTML → échec global, STALE,
 *       AUCUNE invalidation ; ambiguïté → STALE ciblé ; retrait seulement après
 *       vérification positive (lectures saines successives + confirmation) ;
 *   B · priorité : une saisie manuelle vérifiée n'est pas écrasée par la
 *       synchronisation ; plusieurs instances (clé de version partagée) ;
 *   C · statut tarifaire explicite à la trace (missing, zero_or_rounded,
 *       sortie seule), coût exact, alerte dédupliquée ;
 *   D · diagnostic des appels non chiffrés (causes), régularisation dry-run →
 *       export → application unique → reprise → retour arrière, agrégats
 *       journaliers à part, rapport des coûts sans double comptage ;
 *   E · routes BO (Fournisseur IA › tarifs, Coûts IA › non chiffrés).
 */
import { afterAll, beforeAll, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l109l@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const FIX = 'src/services/ai/gateway/pricing/__tests__/fixtures';
const MARKDOC = readFileSync(join(process.cwd(), FIX, 'google-pricing-2026-11-04.markdoc.md.txt'), 'utf8');
const HTML = readFileSync(join(process.cwd(), FIX, 'google-pricing-html-page.html'), 'utf8');
const MODELES = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'];
const NOV = new Date('2026-11-04T09:00:00Z');
const page = (text: string) => async () => ({ text, finalUrl: 'https://aistudio.google.com/docs/pricing', status: 200, contentType: 'text/plain; charset=utf-8' });

scenario('L109L', 'Tarifs Gemini et coûts IA : lecture, STALE, priorité, statut tarifaire, diagnostic, régularisation', ({ sql, make }) => {
  // Lot 114 (#770) : scénario du RÉFÉRENTIEL tarifaire — éprouvé sans la preuve tarifaire de test du socle.
  beforeEach(async () => { (await import('@/services/ai/gateway/pricing/pricing.repository')).__setVerifiedTestPricesForTests(false); });
  let accountId = 0;
  const fetchSpy = vi.fn();

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    accountId = (await make.account()).id;
    for (const t of ['ai_cost_corrections', 'ai_cost_regularization_items', 'ai_cost_regularization_runs', 'ai_model_price_status', 'ai_model_price_changes', 'ai_model_pricing']) {
      await sql.unsafe(`DELETE FROM ${t}`);
    }
    await sql`DELETE FROM ai_alerts WHERE code IN ('ai_pricing_source_unreadable', 'ai_pricing_model_unpriced', 'ai_pricing_unpriced_calls', 'ai_pricing_active_unpriced', 'ai_pricing_stale')`;
    const { clearPricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    clearPricingCache();
  });
  afterAll(async () => {
    const { clearPricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    clearPricingCache();
    vi.restoreAllMocks();
  });

  async function sync(text: string, models = MODELES, now = NOV) {
    const { syncPricingCatalog } = await import('@/services/ai/gateway/pricing/pricing-sync.service');
    return syncPricingCatalog(models, { fetchPage: page(text), billing: null, now: () => now });
  }
  const statut = async (m: string) => (await sql<Array<{ status: string; reason_code: string | null; absent_reads: number; input_per_million: string | null }>>`
    SELECT status, reason_code, absent_reads, input_per_million FROM ai_model_price_status WHERE model = ${m}`)[0];

  it('A — format Markdoc lu, capture (format, empreinte, URL finale) historisée', async () => {
    const r = await sync(MARKDOC);
    expect(r).toMatchObject({ status: 'completed', sourceRead: true });
    expect(r.known.sort()).toEqual([...MODELES].sort());
    expect(r.capture).toMatchObject({ format: 'markdoc', finalUrl: 'https://aistudio.google.com/docs/pricing', httpStatus: 200 });
    const [log] = await sql<Array<{ page_format: string; page_fingerprint: string; final_url: string; status: string }>>`
      SELECT page_format, page_fingerprint, final_url, status FROM ai_model_pricing_refresh_log ORDER BY id DESC LIMIT 1`;
    expect(log).toMatchObject({ page_format: 'markdoc', final_url: 'https://aistudio.google.com/docs/pricing', status: 'completed' });
    expect(log.page_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    expect(calcCostMicros('gemini-3.5-flash-lite', 1_000_000, 0)).toBe(300_000);
    // Montant daté en vigueur à la date du relevé (0,75 $ jusqu'au 31/12/2026), paliers datés conservés.
    const { getCachedPrice } = await import('@/services/ai/gateway/pricing/pricing.repository');
    expect(getCachedPrice('gemini', 'gemini-3.6-flash')).toMatchObject({ inputMicros: 0.75, tiers: [{ kind: 'dated', to: '2026-12-31' }, { kind: 'dated', from: '2027-01-01', inputPerMillion: 1.5 }] });
  });

  it('A — page HTML / format inconnu : échec global, tarifs conservés en STALE, aucune invalidation, alerte dédupliquée', async () => {
    const r = await sync(HTML);
    expect(r).toMatchObject({ status: 'failed', failureCode: 'PAGE_HTML' });
    expect((await statut('gemini-3.5-flash-lite')).status).toBe('STALE');
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM ai_model_pricing WHERE invalidated_at IS NOT NULL`;
    expect(n).toBe(0);
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    expect(calcCostMicros('gemini-3.5-flash-lite', 1_000_000, 0)).toBe(300_000);
    const { getCachedPrice } = await import('@/services/ai/gateway/pricing/pricing.repository');
    expect(getCachedPrice('gemini', 'gemini-3.5-flash-lite')?.stale).toBe(true);
    await sync('');
    const [{ a }] = await sql<Array<{ a: number }>>`SELECT COUNT(*)::int AS a FROM ai_alerts WHERE code = 'ai_pricing_source_unreadable'`;
    expect(a).toBe(1);
    // Relecture saine : KNOWN rétabli, aucune nouvelle ligne de tarif (même montant).
    const [{ avant }] = await sql<Array<{ avant: number }>>`SELECT COUNT(*)::int AS avant FROM ai_model_pricing`;
    await sync(MARKDOC);
    expect((await statut('gemini-3.5-flash-lite')).status).toBe('KNOWN');
    const [{ apres }] = await sql<Array<{ apres: number }>>`SELECT COUNT(*)::int AS apres FROM ai_model_pricing`;
    expect(apres).toBe(avant);
  });

  it('A — modèle connu → nouveau montant daté : nouvelle version ; doublon ambigu : STALE ciblé, sans retrait', async () => {
    const change = MARKDOC.replace('* $0.30 (text / image / video / audio)', '* $0.35 (text / image / video / audio)');
    await sync(change);
    const lignes = await sql<Array<{ input_micros: string }>>`SELECT input_micros FROM ai_model_pricing WHERE model = 'gemini-3.5-flash-lite' ORDER BY effective_from`;
    expect(lignes.map((l) => Number(l.input_micros))).toEqual([0.3, 0.35]);
    const doublon = `${MARKDOC}\n## Doublon\n\n*[\`gemini-3.1-flash-lite\`](x)*\n\n{% tab title="Standard" %}\n{% table %}\n* \n* Free\n* Paid\n---\n* Input price\n* Free\n* $9.00\n---\n* Output price\n* Free\n* $9.00\n{% /table %}\n{% /tab %}\n`;
    const r = await sync(doublon);
    expect(r.stale?.map((s) => s.model)).toContain('gemini-3.1-flash-lite');
    expect(await statut('gemini-3.1-flash-lite')).toMatchObject({ status: 'STALE', reason_code: 'AMBIGUOUS_SECTIONS' });
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM ai_model_pricing WHERE model = 'gemini-3.1-flash-lite' AND invalidated_at IS NOT NULL`;
    expect(n).toBe(0);
  });

  it('A — modèle absent : retrait refusé sans preuve, accepté après lectures saines successives et confirmation', async () => {
    const { confirmModelRetirement } = await import('@/services/ai/gateway/pricing/pricing-sync.service');
    const sans = MARKDOC.replace(/## Gemini 2\.5 Flash\n[\s\S]*?(?=## Gemini 2\.5 Flash-Lite)/, '');
    await sync(sans);
    expect(await statut('gemini-2.5-flash')).toMatchObject({ status: 'STALE', reason_code: 'ABSENT', absent_reads: 1 });
    expect(await confirmModelRetirement('gemini-2.5-flash', session.adminId, 'vérifié sur la page officielle')).toMatchObject({ ok: false, code: 'NOT_ENOUGH_EVIDENCE' });
    await sync(sans);
    const ok = await confirmModelRetirement('gemini-2.5-flash', session.adminId, 'vérifié sur la page officielle');
    expect(ok).toMatchObject({ ok: true });
    const { getCachedPrice } = await import('@/services/ai/gateway/pricing/pricing.repository');
    expect(getCachedPrice('gemini', 'gemini-2.5-flash')).toBeNull();
    expect((await statut('gemini-2.5-flash')).reason_code).toBe('RETIRED_VERIFIED');
  });

  it('B — saisie manuelle vérifiée prioritaire : la synchronisation ne l’écrase pas ; route BO sourcée', async () => {
    const { NextRequest } = await import('next/server');
    const { POST, GET } = await import('@/app/api/admin/ai/provider/pricing/route');
    const post = async (body: unknown) => POST(new NextRequest('http://app.test/api/admin/ai/provider/pricing', { method: 'POST', body: JSON.stringify(body) }) as never);
    const base = { action: 'manual', model: 'gemini-2.5-pro', inputPerMillion: 1.1, outputPerMillion: 9, currency: 'USD', documentDate: '2026-11-03', paidTier: true, tier: 'standard', modality: 'text_image_pdf', thinkingIncluded: true, note: 'grille négociée, avenant du 03/11' };
    expect((await post({ ...base, sourceUrl: 'https://example.com/prix' })).status).toBe(400);
    expect((await post({ ...base, sourceUrl: 'https://cloud.google.com/billing/contrat', note: 'court' })).status).toBe(400);
    expect((await post({ ...base, sourceUrl: 'https://cloud.google.com/billing/contrat' })).status).toBe(200);
    await sync(MARKDOC);
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    expect(calcCostMicros('gemini-2.5-pro', 1_000_000, 0)).toBe(1_100_000);
    const res = await GET(new NextRequest('http://app.test/api/admin/ai/provider/pricing') as never);
    const body = await res.json() as { models: Array<{ model: string; conflict: boolean; applied: { source: string } | null }>; lastSync: { page_format: string } };
    expect(body.lastSync.page_format).toBe('markdoc');
    expect(body.models.find((m) => m.model === 'gemini-2.5-pro')).toMatchObject({ conflict: true, applied: { source: 'manual' } });
  });

  it('B — plusieurs instances : une écriture ailleurs (clé de version) recharge le cache local', async () => {
    const P = await import('@/services/ai/gateway/pricing/pricing.repository');
    await P.loadPricingCache();
    expect(P.getCachedPrice('gemini', 'gemini-l109l-autre')).toBeNull();
    // « Autre instance » : écriture directe + incrément de la clé partagée.
    await sql`INSERT INTO ai_model_pricing (provider, model, input_micros, output_micros, currency, source, verified, effective_from)
              VALUES ('gemini', 'gemini-l109l-autre', 0.2, 0.8, 'USD', 'public_catalog', FALSE, NOW() - interval '1 minute')`;
    await P.bumpPricingVersion('e2e autre instance');
    expect(await P.refreshPricingCacheIfStale(Date.now() + P.PRICING_VERSION_CHECK_MS + 1000)).toBe(true);
    expect(P.getCachedPrice('gemini', 'gemini-l109l-autre')).toMatchObject({ inputMicros: 0.2 });
  });

  it('C — statut tarifaire explicite à la trace : missing (coût NULL), arrondi à 0, sortie seule ; alerte unique', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recordCallTrace } = await import('@/services/ai/telemetry/ai-trace.service');
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    const base = { useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: 'e2e_l109l', accountId, provider: 'gemini', promptVersion: 'e2e', usedFallback: false, durationMs: 1, status: 'success' as const, billable: true, shadow: false };
    const ids: Record<string, string> = {};
    for (const [k, model, i, o] of [['inconnu', 'gemini-l109l-inconnu', 1000, 10], ['arrondi', 'gemini-3.5-flash-lite', 1, 0], ['sortie', 'gemini-l109l-inconnu', 0, 200]] as const) {
      ids[k] = crypto.randomUUID();
      await recordCallTrace({ ...base, traceId: ids[k], model, inputTokens: i, outputTokens: o, costMicros: calcCostMicros(model, i, o) });
    }
    const st = async (t: string) => (await sql<Array<{ pricing_status: string; cost_micros: number | null; cost_exact_micros: string | null }>>`
      SELECT pricing_status, cost_micros, cost_exact_micros FROM ai_usage_event WHERE metadata->>'traceId' = ${t}`)[0];
    expect(await st(ids.inconnu)).toMatchObject({ pricing_status: 'missing', cost_micros: null });
    const arr = await st(ids.arrondi);
    expect(arr).toMatchObject({ pricing_status: 'zero_or_rounded', cost_micros: 0 });
    expect(Number(arr.cost_exact_micros)).toBeGreaterThan(0);
    expect(await st(ids.sortie)).toMatchObject({ pricing_status: 'missing' });
    // Lot 113O (carte #713) : ALIGNÉ — l'alerte « appels non chiffrés » porte
    // le code dédié `ai_pricing_unpriced_calls` (distinct des chaînes actives
    // sans tarif) et reste UNIQUE par modèle tant que la condition dure.
    await vi.waitFor(async () => {
      const [{ n }] = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM ai_alerts WHERE code = 'ai_pricing_unpriced_calls' AND details->>'model' = 'gemini-l109l-inconnu'`;
      expect(n).toBe(1);
    }, { timeout: 3000 });
  });

  // ── D : jeu d'appels anciens dans une fenêtre isolée (mars 2025) ─────────
  const W = { since: new Date('2025-03-01T00:00:00Z'), until: new Date('2025-03-31T23:59:59Z') };
  const evIds: Record<string, number> = {};

  it('D — diagnostic : chaque appel classé par cause, rapprochement avec l’ancienne règle du bandeau', async () => {
    await sql`INSERT INTO ai_model_pricing (provider, model, input_micros, output_micros, currency, source, verified, effective_from, created_at)
              VALUES ('gemini', 'gemini-l109l-a', 0.3, 2.5, 'USD', 'public_catalog', FALSE, '2025-02-01', '2025-02-01'),
                     ('gemini', 'gemini-l109l-c', 0.1, 0.4, 'USD', 'public_catalog', FALSE, '2025-02-01', '2025-02-01'),
                     ('gemini', 'gemini-l109l-c', 0.1, 0.4, 'USD', 'public_catalog', FALSE, '2025-04-01', '2025-04-01')`;
    await sql`UPDATE ai_model_pricing SET invalidated_at = '2025-03-05' WHERE model = 'gemini-l109l-c' AND effective_from = '2025-02-01'`;
    await sql`INSERT INTO ai_model_price_changes (provider, model, old_status, new_status, source, reason, reason_code, detected_at)
              VALUES ('gemini', 'gemini-l109l-c', 'KNOWN', 'UNKNOWN', 'google-pricing-page', 'aucun tableau de prix', 'NO_PRICE_TABLE', '2025-03-05')`;
    await sql`INSERT INTO ai_model_price_status (provider, model, status, source, reason) VALUES ('gemini', 'gemini-l109l-d', 'UNKNOWN', 'google-pricing-page', 'absent de la page tarifaire officielle')
              ON CONFLICT DO NOTHING`;
    const ev = async (k: string, model: string, at: string, i: number, o: number, cost: number | null, meta: Record<string, unknown>, status = 'success') => {
      const [r] = await sql<Array<{ id: number }>>`INSERT INTO ai_usage_event (account_id, operation_type, provider, model, is_billable, input_tokens, output_tokens, cost_micros, status, metadata, use_case_code, created_at)
        VALUES (${accountId}, 'e2e_l109l', 'gemini', ${model}, TRUE, ${i}, ${o}, ${cost}, ${status}, ${JSON.stringify(meta)}::jsonb, 'SOURCE_ANALYSIS', ${at}) RETURNING id`;
      evIds[k] = r.id;
    };
    await ev('cache', 'gemini-l109l-a', '2025-03-10T10:00:00Z', 10_000, 1_000, null, { traceId: 'l109l-1', pricing: null });
    await ev('arrondi', 'gemini-l109l-b', '2025-03-10T10:00:00Z', 2, 0, 0, { traceId: 'l109l-2', pricing: { inputMicros: 0.1, outputMicros: 0.4 } });
    await ev('atort', 'gemini-l109l-c', '2025-03-10T10:00:00Z', 10_000, 0, null, { traceId: 'l109l-3', pricing: null });
    await ev('absent', 'gemini-l109l-d', '2025-03-11T10:00:00Z', 500, 50, null, { traceId: 'l109l-4', pricing: null });
    await ev('couverture', 'gemini-l109l-zz', '2025-03-11T10:00:00Z', 500, 50, null, { traceId: 'l109l-5', pricing: null });
    await ev('conso', 'gemini-l109l-a', '2025-03-12T10:00:00Z', 0, 0, 0, { traceId: 'l109l-6' });
    await ev('ancien', 'gemini-l109l-a', '2025-03-12T10:00:00Z', 1_000, 0, 0, { traceId: 'l109l-7' });
    await sql`INSERT INTO ai_usage_daily_rollup (day, use_case_code, account_id, model, is_billable, calls, failed_calls, unpriced_calls, input_tokens, output_tokens, cost_micros)
              VALUES ('2025-03-15', 'SOURCE_ANALYSIS', ${accountId}, 'gemini-l109l-a', TRUE, 3, 0, 3, 100000, 1000, 0)`;

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => { fetchSpy(...a); return realFetch(...a); }) as typeof fetch;
    try {
      const { aiCostDiagnostic } = await import('@/services/ai/telemetry/cost-diagnostic');
      const q = async (t: string, p: unknown[]) => (await sql.unsafe(t, p as never[])) as unknown as Array<Record<string, unknown>>;
      const d = await aiCostDiagnostic(q, { ...W, accounts: [accountId] });
      const cause = Object.fromEntries(d.byCause.map((c) => [c.cause, c.calls]));
      expect(cause).toEqual({ TARIFF_NOT_IN_GRID: 1, CACHE_NOT_LOADED: 1, WRONGLY_INVALIDATED: 1, MODEL_NOT_COVERED: 1, ZERO_OR_ROUNDED: 1, USAGE_MISSING: 1, LEGACY_NO_PROOF: 1 });
      // Ancienne règle : 6 appels (le « 0 jeton » n'y était pas) ; vrais inconnus : 6 - 1 arrondi = 5 + 1 consommation non mesurée.
      expect(d.reconciliation).toMatchObject({ legacyRuleCalls: 6, zeroOrRoundedCalls: 1, effectiveUnknownCalls: 6 });
      expect(d.rollups).toMatchObject({ rows: 1, unpricedCalls: 3, regularizableCalls: 3 });
      expect(d.byDay.map((x) => x.day)).toEqual(['2025-03-10', '2025-03-11', '2025-03-12']);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { globalThis.fetch = realFetch; }
  });

  it('D — dry-run → export → application unique → refus de double application → retour arrière ; aucun double comptage', async () => {
    const R = await import('@/services/ai/telemetry/cost-regularization');
    const { getCostReport } = await import('@/services/ai/telemetry/cost-report.repository');
    const avant = await getCostReport({ ...W, accountId });
    expect(avant.totals).toMatchObject({ unpricedCalls: 5 + 1 + 3, functionalMicros: 0 });

    const dr = await R.dryRunRegularization(W, session.adminId);
    expect(dr.summary).toMatchObject({ regularize: { calls: 3 + 3, rows: 4 } });
    const [{ n0 }] = await sql<Array<{ n0: number }>>`SELECT COUNT(*)::int AS n0 FROM ai_cost_corrections`;
    expect(n0).toBe(0);
    const csv = await R.regularizationExport(dr.runId);
    expect(csv?.split('\n')[0]).toMatch(/avant_cout_micro_usd.*apres_cout_micro_usd/);
    expect(csv).toMatch(/keep_unpriced/);

    const ap = await R.applyRegularization(dr.runId, session.adminId);
    expect(ap).toMatchObject({ status: 'completed', summary: { written: 4 } });
    expect(await R.applyRegularization(dr.runId, session.adminId)).toMatchObject({ status: 'refused', refused: 'ALREADY_APPLIED' });

    // Trace initiale intacte, correction à part.
    const [e1] = await sql<Array<{ cost_micros: number | null; pricing: unknown }>>`SELECT cost_micros, metadata->'pricing' AS pricing FROM ai_usage_event WHERE id = ${evIds.cache}`;
    expect(e1).toMatchObject({ cost_micros: null, pricing: null });
    const [c1] = await sql<Array<{ corrected_cost_micros: string; method: string; method_version: string }>>`SELECT corrected_cost_micros, method, method_version FROM ai_cost_corrections WHERE target_id = ${evIds.cache} AND target_kind = 'event'`;
    expect(c1).toMatchObject({ method: 'valid_at_call', method_version: 'l109l-v1' });
    expect(Number(c1.corrected_cost_micros)).toBe(3000 + 2500);

    const apres = await getCostReport({ ...W, accountId });
    // 5 500 (cache) + 1 000 (à tort, 10 000 × 0,1) + 300 (ancien) + 100 000 × 0,3 + 1 000 × 2,5 (agrégat) = 39 300.
    expect(apres.totals).toMatchObject({ functionalMicros: 5500 + 1000 + 300 + 32_500, regularizedCalls: 3 + 3, unpricedCalls: 3, initialMicros: 0 });

    const rv = await R.revertRegularization(ap.runId, session.adminId);
    expect(rv).toMatchObject({ status: 'completed', summary: { reverted: 4 } });
    expect((await getCostReport({ ...W, accountId })).totals.functionalMicros).toBe(0);

    // Reprise après interruption : une correction déjà écrite par une application interrompue est ignorée.
    const dr2 = await R.dryRunRegularization(W, session.adminId);
    const [item] = await sql<Array<Record<string, unknown>>>`SELECT * FROM ai_cost_regularization_items WHERE run_id = ${dr2.runId} AND decision = 'regularize' ORDER BY id LIMIT 1`;
    const [interrompu] = await sql<Array<{ id: number }>>`INSERT INTO ai_cost_regularization_runs (mode, status, since, until, method_version, dry_run_id) VALUES ('apply', 'interrupted', ${W.since.toISOString()}, ${W.until.toISOString()}, 'l109l-v1', ${dr2.runId}) RETURNING id`;
    await sql`INSERT INTO ai_cost_corrections (target_kind, target_id, run_id, dry_run_id, call_at, corrected_cost_micros, cause, method, method_version, price_ref)
              VALUES (${item.target_kind as string}, ${Number(item.target_id)}, ${interrompu.id}, ${dr2.runId}, ${new Date(item.call_at as string).toISOString()}, ${Number(item.corrected_cost_micros)}, ${item.cause as string}, 'valid_at_call', 'l109l-v1', '{}'::jsonb)`;
    const ap2 = await R.applyRegularization(dr2.runId, session.adminId);
    expect(ap2).toMatchObject({ status: 'completed', summary: { written: 3, skipped: 1 } });
    expect((await getCostReport({ ...W, accountId })).totals.functionalMicros).toBe(5500 + 1000 + 300 + 32_500);
  });

  it('E — routes BO : détail des non chiffrés (JSON et texte), coûts avec complétude', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/admin/ai/costs/unpriced/route');
    const q = `since=${W.since.toISOString()}&until=${W.until.toISOString()}&accountId=${accountId}`;
    const j = await GET(new NextRequest(`http://app.test/api/admin/ai/costs/unpriced?${q}`) as never);
    expect(j.status).toBe(200);
    const body = await j.json() as { reconciliation: { alreadyCorrected: number } };
    expect(body.reconciliation.alreadyCorrected).toBe(3);
    const t = await GET(new NextRequest(`http://app.test/api/admin/ai/costs/unpriced?${q}&format=txt`) as never);
    expect(await t.text()).toMatch(/Ancienne règle du bandeau/);
    const costs = await import('@/app/api/admin/ai/costs/route');
    const c = await costs.GET(new NextRequest(`http://app.test/api/admin/ai/costs?since=${W.since.toISOString()}&until=${W.until.toISOString()}&accountId=${accountId}`) as never);
    const cb = await c.json() as { completeness: string; warning: string | null; averageIsPartial: boolean };
    expect(cb).toMatchObject({ completeness: 'partial', averageIsPartial: true });
    expect(cb.warning).toMatch(/sans tarif connu/);
  });
});
