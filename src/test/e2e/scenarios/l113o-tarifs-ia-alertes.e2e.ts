/**
 * L113O — carte #713 « BUG P1 — Tarification IA : corriger les alertes
 * persistantes après le lot 109L » (base PostgreSQL réelle, aucun appel IA,
 * aucun réseau : la page est injectée depuis les fixtures RÉELLES du dépôt).
 *
 *   A · contenu INTÉGRAL reçu conservé et téléchargeable ; identifiant sous un
 *       regroupement `###` lu ; identifiant présent mais non lu → NOT_PARSED
 *       (jamais ABSENT, jamais compté pour un retrait) ; chute de couverture →
 *       échec documenté, KNOWN → STALE, AUCUN retrait ; HTTP non-200 → corps
 *       conservé, échec ;
 *   B · alias `*-latest` chiffré au modèle SERVI (modelVersion) ; sans preuve :
 *       inconnu ; multimodal mesuré → chiffré, non mesuré → consommation non
 *       mesurée ; régularisation d'un alias historique au tarif du modèle servi ;
 *   C · cycle de vie des alertes : 17 alertes héritées (une par modèle et par
 *       jour) → une par condition ; historique seul ≠ chaîne active ; tarif
 *       redevenu applicable → résolu ; régularisation → résolu ; vraie
 *       inconnue → reste visible ; historique consultable ; tableau de bord
 *       = UNE synthèse ;
 *   D · rapport de réconciliation JSON / CSV des 17 identifiants, cache par
 *       instance, migrations 1520-1522 rejouables.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l113o@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const FIX = 'src/services/ai/gateway/pricing/__tests__/fixtures';
const MARKDOC = readFileSync(join(process.cwd(), FIX, 'google-pricing-2026-11-04.markdoc.md.txt'), 'utf8');
const SECTION_25_LITE = /## Gemini 2\.5 Flash-Lite\n[\s\S]*?(?=\n## |$)/;
/** Les 17 identifiants de la capture préprod du 06/11/2026 (ticket §1). */
const CAPTURE = [
  'gemini-omni-1.2-flash', 'gemini-omni-1.1-flash', 'gemini-nano-banana-2.1', 'gemini-2.5-flash-lite',
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-4-argon', 'gemini-pro-latest', 'gemini-3-pro-image', 'gemini-3.5-flash',
  'gemini-flash-latest', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest', 'gemini-3.8-flash-lite-tts',
];
const MODELES = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-image'];
const page = (text: string, status = 200) => async () => ({ text, finalUrl: 'https://aistudio.google.com/docs/pricing?authuser=1', status, contentType: 'text/plain; charset=utf-8' });

scenario('L113O', 'Tarifs IA : page réellement reçue, absence vérifiée, alias, multimodal, cycle de vie des alertes, réconciliation', ({ sql, make }) => {
  let accountId = 0;

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    accountId = (await make.account()).id;
    for (const t of ['ai_cost_corrections', 'ai_cost_regularization_items', 'ai_cost_regularization_runs', 'ai_model_price_status', 'ai_model_price_changes', 'ai_model_pricing', 'ai_model_pricing_refresh_log', 'ai_model_pricing_page_snapshots']) {
      await sql.unsafe(`DELETE FROM ${t}`);
    }
    await sql`DELETE FROM ai_alerts WHERE code LIKE 'ai_pricing_%'`;
    const { clearPricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    clearPricingCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterAll(async () => {
    const { clearPricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    clearPricingCache();
    vi.restoreAllMocks();
  });

  async function sync(text: string, models = MODELES) {
    const { syncPricingCatalog } = await import('@/services/ai/gateway/pricing/pricing-sync.service');
    return syncPricingCatalog(models, { fetchPage: page(text), billing: null });
  }
  const statut = async (m: string) => (await sql<Array<{ status: string; reason_code: string | null; absent_reads: number }>>`
    SELECT status, reason_code, absent_reads FROM ai_model_price_status WHERE model = ${m}`)[0];
  const ouvertes = async () => sql<Array<{ id: number; code: string; condition_key: string | null; severity: string; details: Record<string, unknown> }>>`
    SELECT id, code, condition_key, severity, details FROM ai_alerts WHERE code LIKE 'ai_pricing_%' AND resolved_at IS NULL ORDER BY id`;

  it('A1 — page réellement reçue : contenu INTÉGRAL conservé (empreinte, lien au journal), téléchargeable ; gemini-2.5-flash-lite KNOWN', async () => {
    const r = await sync(MARKDOC);
    expect(r).toMatchObject({ status: 'completed' });
    expect(r.known).toContain('gemini-2.5-flash-lite');
    const [log] = await sql<Array<{ snapshot_id: number; page_model_ids: string[]; page_sections: number; final_url: string }>>`
      SELECT snapshot_id, page_model_ids, page_sections, final_url FROM ai_model_pricing_refresh_log ORDER BY id DESC LIMIT 1`;
    expect(Number(log.snapshot_id)).toBeGreaterThan(0);
    expect(log.page_model_ids).toContain('gemini-2.5-flash-lite');
    const [snap] = await sql<Array<{ body: string; final_url: string; fingerprint: string }>>`SELECT body, final_url, fingerprint FROM ai_model_pricing_page_snapshots WHERE id = ${log.snapshot_id}`;
    expect(snap.body).toBe(MARKDOC);
    expect(snap.final_url).toBe('https://aistudio.google.com/docs/pricing'); // sans paramètres
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/admin/ai/provider/pricing/snapshot/route');
    const res = await GET(new NextRequest(`http://app.test/api/admin/ai/provider/pricing/snapshot?id=${log.snapshot_id}`) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(await res.text()).toBe(MARKDOC);
    // Même page relue : une seule copie (dédoublonnée par empreinte).
    await sync(MARKDOC);
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM ai_model_pricing_page_snapshots`;
    expect(n).toBe(1);
  });

  it('A2 — regroupement « ### » (l’ancien lecteur rendait ABSENT) : lu ; identifiant présent mais non lu : NOT_PARSED, STALE conservé, jamais compté pour un retrait', async () => {
    const groupe = MARKDOC.replace('## Gemini 2.5 Flash-Lite\n', '## Gemini 2.5 models\n\n### Gemini 2.5 Flash-Lite\n');
    await sync(groupe);
    expect(await statut('gemini-2.5-flash-lite')).toMatchObject({ status: 'KNOWN' });
    const perdu = MARKDOC.replace(SECTION_25_LITE, '## Deprecated models\n\nThe model `gemini-2.5-flash-lite` will be shut down; see the models page.\n');
    const r = await sync(perdu);
    expect(r.stale?.find((s) => s.model === 'gemini-2.5-flash-lite')).toMatchObject({ code: 'NOT_PARSED' });
    expect(await statut('gemini-2.5-flash-lite')).toMatchObject({ status: 'STALE', reason_code: 'NOT_PARSED', absent_reads: 0 });
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    expect(calcCostMicros('gemini-2.5-flash-lite', 1_000_000, 0)).toBe(100_000); // dernier montant documenté, non confirmé
    const { confirmModelRetirement } = await import('@/services/ai/gateway/pricing/pricing-sync.service');
    expect(await confirmModelRetirement('gemini-2.5-flash-lite', session.adminId, 'essai de retrait sans preuve')).toMatchObject({ ok: false, code: 'NOT_ENOUGH_EVIDENCE' });
    await sync(MARKDOC);
    expect(await statut('gemini-2.5-flash-lite')).toMatchObject({ status: 'KNOWN' });
  });

  it('A3 — page lisible mais sections perdues (chute de couverture) : échec documenté, aucun retrait, KNOWN → STALE ; une alerte « source », résolue à la relecture saine', async () => {
    const tronquee = MARKDOC.split(/\n(?=## )/).slice(0, 4).join('\n');
    const r = await sync(tronquee);
    expect(r).toMatchObject({ status: 'failed', failureCode: 'COVERAGE_DROP' });
    const [{ inv }] = await sql<Array<{ inv: number }>>`SELECT COUNT(*)::int AS inv FROM ai_model_pricing WHERE invalidated_at IS NOT NULL`;
    expect(inv).toBe(0);
    expect((await statut('gemini-2.5-pro')).status).toBe('STALE');
    await sync(tronquee);
    const src = (await ouvertes()).filter((a) => a.code === 'ai_pricing_source_unreadable');
    expect(src).toHaveLength(1);
    expect(src[0].condition_key).toBe('pricing:source');
    await sync(MARKDOC);
    expect((await statut('gemini-2.5-pro')).status).toBe('KNOWN');
    expect((await ouvertes()).filter((a) => a.code === 'ai_pricing_source_unreadable')).toHaveLength(0);
    const [res] = await sql<Array<{ resolution_code: string; resolution_reason: string; resolved_by: number | null }>>`
      SELECT resolution_code, resolution_reason, resolved_by FROM ai_alerts WHERE condition_key = 'pricing:source'`;
    expect(res).toMatchObject({ resolution_code: 'CONDITION_CLEARED', resolved_by: null });
  });

  it('A4 — HTTP non-200 : corps reçu conservé, échec, aucun retrait', async () => {
    const { syncPricingCatalog } = await import('@/services/ai/gateway/pricing/pricing-sync.service');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('<html><body>Before you continue to Google</body></html>', { status: 503, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    try {
      const r = await syncPricingCatalog(MODELES, { billing: null });
      expect(r).toMatchObject({ status: 'failed', failureCode: 'HTTP_ERROR' });
      expect(r.capture).toMatchObject({ httpStatus: 503, format: 'html' });
      const [s] = await sql<Array<{ body: string; http_status: number }>>`SELECT body, http_status FROM ai_model_pricing_page_snapshots ORDER BY id DESC LIMIT 1`;
      expect(s).toMatchObject({ http_status: 503, body: expect.stringMatching(/Before you continue/) });
    } finally { globalThis.fetch = realFetch; }
    const [{ inv }] = await sql<Array<{ inv: number }>>`SELECT COUNT(*)::int AS inv FROM ai_model_pricing WHERE invalidated_at IS NOT NULL`;
    expect(inv).toBe(0);
    await sync(MARKDOC);
  });

  const base = () => ({ useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: 'e2e_l113o', accountId, provider: 'gemini', promptVersion: 'e2e', usedFallback: false, durationMs: 1, status: 'success' as const, billable: true, shadow: false });
  const trace = async (traceId: string) => (await sql<Array<{ pricing_status: string; cost_micros: number | null; metadata: Record<string, unknown> }>>`
    SELECT pricing_status, cost_micros, metadata FROM ai_usage_event WHERE metadata->>'traceId' = ${traceId}`)[0];

  it('B1 — alias *-latest : tarif du modèle SERVI (modelVersion), modèle servi conservé ; sans preuve : inconnu, jamais un prix supposé', async () => {
    const { recordCallTrace } = await import('@/services/ai/telemetry/ai-trace.service');
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    const t1 = crypto.randomUUID(); const t2 = crypto.randomUUID();
    await recordCallTrace({ ...base(), traceId: t1, model: 'gemini-flash-lite-latest', inputTokens: 10_000, outputTokens: 100, costMicros: calcCostMicros('gemini-flash-lite-latest', 10_000, 100), providerMeta: { modelVersion: 'gemini-3.5-flash-lite' } } as never);
    await recordCallTrace({ ...base(), traceId: t2, model: 'gemini-flash-lite-latest', inputTokens: 10_000, outputTokens: 100, costMicros: null } as never);
    const a = await trace(t1);
    expect(a).toMatchObject({ pricing_status: 'applied', cost_micros: 3250 });
    expect(a.metadata).toMatchObject({ pricedModel: 'gemini-3.5-flash-lite', pricingBasis: 'served_model', providerMeta: { modelVersion: 'gemini-3.5-flash-lite' }, pricing: { inputMicros: 0.3 } });
    expect(await trace(t2)).toMatchObject({ pricing_status: 'missing', cost_micros: null });
  });

  it('B2 — multimodal : sortie image mesurée par modalité → chiffrée ; non mesurée → « consommation non mesurée », coût NULL', async () => {
    const { recordCallTrace } = await import('@/services/ai/telemetry/ai-trace.service');
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    expect(calcCostMicros('gemini-3.1-flash-image', 1000, 1290)).toBeNull(); // jamais le tarif texte appliqué aux images
    const t1 = crypto.randomUUID(); const t2 = crypto.randomUUID();
    await recordCallTrace({ ...base(), traceId: t1, model: 'gemini-3.1-flash-image', inputTokens: 1000, outputTokens: 1290, costMicros: null, providerMeta: { tokensByModality: { input: { text: 1000 }, output: { image: 1290 } } } } as never);
    await recordCallTrace({ ...base(), traceId: t2, model: 'gemini-3.1-flash-image', inputTokens: 1000, outputTokens: 1290, costMicros: null } as never);
    expect(await trace(t1)).toMatchObject({ pricing_status: 'applied', cost_micros: 1000 * 0.5 + 1290 * 60 });
    const b = await trace(t2);
    expect(b).toMatchObject({ pricing_status: 'insufficient_usage', cost_micros: null });
    expect(b.metadata).toMatchObject({ pricingReason: 'MODALITY_USAGE_UNMEASURED' });
  });

  // ── C : 17 alertes héritées, appels historiques, chaînes actives ─────────
  let chaines: string[] = [];
  const HISTO = 'gemini-omni-1.1-flash'; // seulement dans l'historique
  const REVIENT = 'gemini-4-argon';      // tarif saisi ensuite (redevient applicable)

  it('C1 — 17 alertes héritées (une par modèle et par jour) → une alerte par condition ; historique seul ≠ chaîne active', async () => {
    const { loadActiveChains } = await import('@/services/ai/provider/active-model-anomalies');
    chaines = [...new Set((await loadActiveChains()).map((c) => c.model))];
    // Héritage 109L : deux jours d'alertes pour chacun des 17 identifiants.
    for (const jour of ['2026-11-05', '2026-11-06']) {
      for (const m of CAPTURE) {
        const absent = ['gemini-omni-1.2-flash', 'gemini-omni-1.1-flash', 'gemini-nano-banana-2.1', 'gemini-2.5-flash-lite'].includes(m);
        await sql`INSERT INTO ai_alerts (kind, code, severity, message, details, dedupe_key, created_at)
                  VALUES ('anomaly', 'ai_pricing_model_unpriced', 'warning',
                          ${absent ? `Tarif IA inconnu pour ${m}, modèle utilisé : ses appels sont non chiffrés (ABSENT — absent de la page tarifaire officielle).` : `Appels IA non chiffrés : aucun tarif applicable pour gemini/${m} (coût non calculable, jamais estimé).`},
                          ${JSON.stringify({ model: m })}::jsonb, ${`ai:pricing-model:${m}:UNKNOWN:${jour}`}, ${`${jour}T08:00:00Z`})`;
      }
    }
    // Appels réellement non chiffrés de deux modèles (hier).
    for (const [m, n] of [[HISTO, 3], [REVIENT, 2]] as const) {
      for (let i = 0; i < n; i++) {
        await sql`INSERT INTO ai_usage_event (account_id, operation_type, provider, model, is_billable, input_tokens, output_tokens, cost_micros, status, metadata, use_case_code, pricing_status, created_at)
                  VALUES (${accountId}, 'e2e_l113o', 'gemini', ${m}, TRUE, 2000, 100, NULL, 'success', ${JSON.stringify({ traceId: `l113o-${m}-${i}`, pricing: null })}::jsonb, 'SOURCE_ANALYSIS', 'missing', NOW() - interval '1 day')`;
      }
    }
    const { reconcilePricingAlerts } = await import('@/services/ai/gateway/pricing/pricing-supervision');
    const r = await reconcilePricingAlerts('e2e');
    expect(r).not.toBeNull();
    const open = await ouvertes();
    // Plus aucune alerte héritée ouverte : 34 alertes → une par condition.
    expect(open.filter((a) => a.condition_key === null)).toHaveLength(0);
    expect(open.filter((a) => a.condition_key === `pricing:calls:${HISTO}`)).toHaveLength(1);
    // Modèle seulement dans l'historique : aucune fausse alerte « chaîne active ».
    if (!chaines.includes(HISTO)) expect(open.some((a) => a.condition_key === `pricing:active:${HISTO}`)).toBe(false);
    // Les chaînes actives sans tarif, elles, restent visibles (risque futur).
    const { getCachedPrice } = await import('@/services/ai/gateway/pricing/pricing.repository');
    for (const m of chaines.filter((x) => !getCachedPrice('gemini', x))) {
      expect(open.filter((a) => a.condition_key === `pricing:active:${m}`)).toHaveLength(1);
    }
    const [{ sup, clr }] = await sql<Array<{ sup: number; clr: number }>>`
      SELECT COUNT(*) FILTER (WHERE resolution_code = 'SUPERSEDED')::int AS sup, COUNT(*) FILTER (WHERE resolution_code = 'CONDITION_CLEARED')::int AS clr
        FROM ai_alerts WHERE code = 'ai_pricing_model_unpriced'`;
    expect(sup + clr).toBe(34); // historique conservé : aucune ligne supprimée
    expect(sup).toBeGreaterThanOrEqual(4);
    // Recontrôle répété : aucune nouvelle alerte (une par condition, pas une par jour).
    const avant = (await ouvertes()).length;
    await reconcilePricingAlerts('e2e-2');
    expect((await ouvertes()).length).toBe(avant);
    const [{ occ }] = await sql<Array<{ occ: number }>>`SELECT occurrences AS occ FROM ai_alerts WHERE condition_key = ${`pricing:calls:${HISTO}`} AND resolved_at IS NULL`;
    expect(occ).toBeGreaterThanOrEqual(2);
  });

  it('C2 — tarif redevenu applicable : appels « à régulariser » (information) ; régularisation → alerte résolue ; la vraie inconnue reste visible', async () => {
    const { NextRequest } = await import('next/server');
    const pricing = await import('@/app/api/admin/ai/provider/pricing/route');
    const res = await pricing.POST(new NextRequest('http://app.test/api/admin/ai/provider/pricing', { method: 'POST', body: JSON.stringify({
      action: 'manual', model: REVIENT, inputPerMillion: 0.2, outputPerMillion: 1, currency: 'USD', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      documentDate: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10), effectiveFrom: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
      paidTier: true, tier: 'standard', modality: 'text_image_pdf', thinkingIncluded: true, note: 'relevé e2e du tarif officiel',
    }) }) as never);
    expect(res.status).toBe(200);
    const calls = (await ouvertes()).find((a) => a.condition_key === `pricing:calls:${REVIENT}`);
    expect(calls).toMatchObject({ severity: 'info', details: expect.objectContaining({ priceNow: true }) });
    expect((await ouvertes()).some((a) => a.condition_key === `pricing:active:${REVIENT}`)).toBe(false);

    const R = await import('@/services/ai/telemetry/cost-regularization');
    const W = { since: new Date(Date.now() - 2 * 86_400_000), until: new Date() };
    const dr = await R.dryRunRegularization(W, session.adminId);
    const csv = await R.regularizationExport(dr.runId);
    expect(csv).toMatch(/avant_cout_micro_usd.*apres_cout_micro_usd/);
    const reg = await R.applyRegularization(dr.runId, session.adminId);
    expect(reg.status).toBe('completed');
    const { reconcilePricingAlerts } = await import('@/services/ai/gateway/pricing/pricing-supervision');
    await reconcilePricingAlerts('e2e-apres-regularisation');
    const open = await ouvertes();
    expect(open.some((a) => a.condition_key === `pricing:calls:${REVIENT}`)).toBe(false);
    // Vraie inconnue : toujours signalée, au bon endroit (appels historiques).
    expect(open.some((a) => a.condition_key === `pricing:calls:${HISTO}`)).toBe(true);
    // Coût d'origine conservé, correction à part.
    const [e] = await sql<Array<{ cost_micros: number | null }>>`SELECT cost_micros FROM ai_usage_event WHERE model = ${REVIENT} LIMIT 1`;
    expect(e.cost_micros).toBeNull();
    const [{ c }] = await sql<Array<{ c: number }>>`SELECT COUNT(*)::int AS c FROM ai_cost_corrections k JOIN ai_usage_event u ON u.id = k.target_id WHERE k.target_kind = 'event' AND u.model = ${REVIENT} AND k.reverted_at IS NULL`;
    expect(c).toBe(2);
    // Historique des résolutions consultable.
    const { listAlerts } = await import('@/services/ai/alerts/alerts.repository');
    const resolues = await listAlerts({ status: 'resolved', codes: ['ai_pricing_unpriced_calls'] });
    expect(resolues.some((a) => (a.details as { model?: string }).model === REVIENT && a.resolutionCode === 'CONDITION_CLEARED')).toBe(true);
  });

  it('B3 — alias historique non chiffré : régularisé au tarif du modèle servi (preuve API), coût d’origine conservé, aucun appel IA', async () => {
    // Appel postérieur à l'inscription du tarif public du modèle servi (A1).
    // Correctif 113 (e2e complet du 06/11, échec observé une fois) : l'horodatage de l'appel est
    // calé sur la ligne de tarif réellement en vigueur (inscription ET début de validité), au lieu
    // de « maintenant − 1 s » — une resynchronisation des étapes précédentes peut avoir inscrit
    // une nouvelle ligne moins d'une seconde avant ce test. L'attendu ne change pas.
    const [tarif] = await sql<Array<{ t: Date }>>`
      SELECT greatest(created_at, effective_from) AS t FROM ai_model_pricing
       WHERE provider = 'gemini' AND model = 'gemini-3.5-flash-lite' AND invalidated_at IS NULL
       ORDER BY effective_from DESC, id DESC LIMIT 1`;
    expect(tarif, 'tarif public du modèle servi inscrit par A1').toBeTruthy();
    const at = new Date(new Date(tarif.t).getTime() + 1).toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const [ev] = await sql<Array<{ id: number }>>`INSERT INTO ai_usage_event (account_id, operation_type, provider, model, is_billable, input_tokens, output_tokens, cost_micros, status, metadata, use_case_code, pricing_status, created_at)
      VALUES (${accountId}, 'e2e_l113o', 'gemini', 'gemini-flash-latest', TRUE, 1000, 0, NULL, 'success', ${JSON.stringify({ traceId: 'l113o-alias', pricing: null, providerMeta: { modelVersion: 'models/gemini-3.5-flash-lite' } })}::jsonb, 'SOURCE_ANALYSIS', 'missing', ${at}) RETURNING id`;
    const realFetch = globalThis.fetch;
    const spy = vi.fn();
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => { spy(...a); return realFetch(...a); }) as typeof fetch;
    try {
      const R = await import('@/services/ai/telemetry/cost-regularization');
      const dr = await R.dryRunRegularization({ since: new Date(Date.now() - 2 * 3600_000), until: new Date(Date.now() + 1000) }, session.adminId);
      const [item] = await sql<Array<{ decision: string; corrected_cost_micros: string; price_ref: Record<string, unknown> }>>`
        SELECT decision, corrected_cost_micros, price_ref FROM ai_cost_regularization_items WHERE run_id = ${dr.runId} AND target_id = ${ev.id}`;
      expect(item).toMatchObject({ decision: 'regularize', price_ref: expect.objectContaining({ pricedModel: 'gemini-3.5-flash-lite', basis: 'served_model' }) });
      expect(Number(item.corrected_cost_micros)).toBe(300);
      expect(spy).not.toHaveBeenCalled();
    } finally { globalThis.fetch = realFetch; }
  });

  it('C3 — tableau de bord : UNE synthèse groupée (compteurs, liens), aucune alerte tarifaire en bandeau individuel', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/admin/ai/dashboard/route');
    const res = await GET(new NextRequest('http://app.test/api/admin/ai/dashboard?recheck=1') as never);
    const body = await res.json() as { alerts: Array<{ message: string }>; pricingSummary: { severity: string; counters: Record<string, unknown>; links: Record<string, string>; recentlyResolved: unknown[] } };
    expect(body.pricingSummary).toMatchObject({ links: { pricing: '/admin/ai-provider#tarifs', costs: '/admin/ai-costs?unpriced=1' } });
    expect(body.pricingSummary.counters.unpricedCalls).toBeGreaterThanOrEqual(3);
    expect(body.pricingSummary.recentlyResolved.length).toBeGreaterThan(0);
    expect(body.alerts.some((a) => /Tarif IA inconnu|Appels IA non chiffrés/.test(a.message))).toBe(false);
  });

  it('D1 — rapport de réconciliation des 17 identifiants (JSON / CSV), cause par catégorie, cache par instance, migrations', async () => {
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/admin/ai/provider/pricing/reconciliation/route');
    const q = `models=${encodeURIComponent(CAPTURE.join(','))}`;
    const j = await GET(new NextRequest(`http://app.test/api/admin/ai/provider/pricing/reconciliation?${q}`) as never);
    expect(j.status).toBe(200);
    const r = await j.json() as { models: Array<{ model: string; primaryCause: string; alertState: string; page: { verdict: string; mentioned: boolean }; action: string; pricing: string }>; snapshot: { id: number } | null; migrations: Array<{ present: boolean }>; cache: { consistent: boolean | null; instances: unknown[] } };
    for (const m of CAPTURE) expect(r.models.find((x) => x.model === m)?.primaryCause, m).toBeTruthy();
    const de = (m: string) => r.models.find((x) => x.model === m)!;
    expect(de('gemini-2.5-flash-lite')).toMatchObject({ page: { verdict: 'KNOWN', mentioned: true } });
    // Cause sous-jacente prouvée ET état actuel de l'alerte (résolue : ni chaîne active ni appel non chiffré).
    expect(de('gemini-omni-1.2-flash')).toMatchObject({ primaryCause: 'ABSENT_VERIFIED', alertState: 'resolved', page: { verdict: 'ABSENT', mentioned: false } });
    expect(de('gemini-3.8-flash').primaryCause).not.toBe('ABSENT_VERIFIED');
    expect(de('gemini-4-argon').pricing).toMatch(/0\.2 \$ \/ 1 \$/);
    expect(r.snapshot?.id).toBeGreaterThan(0);
    expect(r.migrations.every((m) => m.present)).toBe(true);
    expect(r.cache.instances.length).toBeGreaterThan(0);
    expect(r.cache.consistent).toBe(true);
    const c = await GET(new NextRequest(`http://app.test/api/admin/ai/provider/pricing/reconciliation?${q}&format=csv`) as never);
    expect(c.headers.get('content-type')).toMatch(/text\/csv/);
    const csv = await c.text();
    expect(csv.split('\r\n').filter(Boolean).length).toBeGreaterThanOrEqual(18);
    expect(csv).not.toMatch(/AIza|postgres:\/\//);
  });

  it('D2 — migrations 1520-1522 rejouables', async () => {
    for (const f of ['1520_l113o_snapshots_tarifs.sql', '1521_l113o_alertes_resolution.sql', '1522_l113o_cache_tarifs_instances.sql']) {
      const txt = readFileSync(join(process.cwd(), 'src/db/migrations', f), 'utf8');
      await sql.begin(async (tx) => { await tx.unsafe(txt); });
      await sql.begin(async (tx) => { await tx.unsafe(txt); });
    }
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM ai_model_pricing_page_snapshots`;
    expect(n).toBeGreaterThan(0);
  });
});
