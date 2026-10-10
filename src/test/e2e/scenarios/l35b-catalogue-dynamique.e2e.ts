/**
 * Lot 35B sur PostgreSQL réel — ticket « Catalogue IA dynamique Google :
 * modèles, tarifs, Preview et alertes BO » (migrations 0303, 0304),
 * critères d'acceptation CAT-01 à CAT-16 :
 *   · Google expose de nouveaux modèles À LA CLÉ ACTIVE, sans commit ni
 *     déploiement : la synchronisation les découvre, les qualifie, les
 *     propose (preview compris, tarif UNKNOWN compris), le bandeau les signale,
 *     son acquittement est persistant ;
 *   · expérimental jamais proposé, modèle retiré plus proposé, modèle actif
 *     jamais remplacé (alerte d'exploitation + anomalie visible) ;
 *   · tarifs historisés, coûts passés jamais revalorisés, ambiguïté → UNKNOWN,
 *     panne de la source tarifaire sans effet sur le démarrage ni l'usage ;
 *   · bouton « Actualiser le catalogue » et tâche planifiée = même fonction.
 * Aucun réseau : listing Google, page tarifaire (extrait représentatif) et
 * épreuves de qualification sont simulés.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l35b@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const CLE = 'cle-e2e-l35b';
const PAGE = readFileSync(join(process.cwd(), 'src/services/ai/gateway/pricing/__tests__/fixtures/google-pricing-2026-10.md.txt'), 'utf8');
const CONNUS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-pro'];

/** Listing `GET /v1beta/models` simulé. */
function listing(models: Array<string | { name: string; displayName?: string }>) {
  return {
    models: models.map((m) => {
      const name = typeof m === 'string' ? m : m.name;
      return {
        name: `models/${name}`, displayName: typeof m === 'string' ? undefined : m.displayName,
        supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536,
      };
    }),
  };
}
const fetcherDe = (models: Parameters<typeof listing>[0]) => (async () => new Response(JSON.stringify(listing(models)), { status: 200 })) as unknown as typeof fetch;

/** Épreuves de qualification simulées : tout réussit (conforme au schéma). */
const qualifOk = vi.fn(async (i: { responseSchema?: unknown; attachments: unknown[] }) => ({
  rawText: i.responseSchema ? '{"ok":true,"mot":"verebona"}' : 'OK', inputTokens: 4, outputTokens: 2,
}));
const sonde = async () => ({ rawText: 'OK' });

scenario('L35B', 'Catalogue IA dynamique : découverte, qualification, preview, tarifs, bandeau, retraits', ({ sql, make }) => {
  let versionsAvant = '';
  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status', 'ai_model_price_status', 'ai_model_price_changes', 'ai_model_pricing']) {
      await sql.unsafe(`DELETE FROM ${t}`);
    }
    await sql`DELETE FROM ai_model_catalog_refresh`;
    await sql`DELETE FROM ai_alerts WHERE code IN ('ai_active_model_unavailable', 'ai_pricing_source_unreadable')`;
    const { clearPricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    clearPricingCache();
    versionsAvant = JSON.stringify(await sql`SELECT id, status, updated_at FROM ai_config_versions ORDER BY id`);
  });

  afterAll(async () => {
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(null);
    const { clearPricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    clearPricingCache();
  });

  async function sync(models: Parameters<typeof listing>[0], page: () => Promise<string> = async () => PAGE, now?: Date) {
    const { syncAiCatalog } = await import('@/services/ai/provider/ai-catalog-sync.service');
    return syncAiCatalog({ trigger: 'schedule' }, {
      fetcher: fetcherDe(models), qualificationCall: qualifOk as never, probeCall: sonde, pricing: { fetchPage: page, billing: null, ...(now ? { now: () => now } : {}) },
      ...(now ? { now: () => now } : {}),
    });
  }
  async function get(path: string, mod: Promise<{ GET: (r: never) => Promise<Response> }>) {
    const { NextRequest } = await import('next/server');
    const res = await (await mod).GET(new NextRequest(`http://app.test${path}`) as never);
    return { status: res.status, body: await res.json() as Record<string, any> };
  }
  const catalogues = () => get('/api/admin/ai/config-catalogs', import('@/app/api/admin/ai/config-catalogs/route') as never);
  const statut = () => get('/api/admin/ai/catalog-status', import('@/app/api/admin/ai/catalog-status/route') as never);
  async function acquitter(models: string[]) {
    const { POST } = await import('@/app/api/admin/ai/catalog-status/route');
    const { NextRequest } = await import('next/server');
    const res = await POST(new NextRequest('http://app.test/api/admin/ai/catalog-status', {
      method: 'POST', body: JSON.stringify({ acknowledge: models }), headers: { 'content-type': 'application/json' },
    }));
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  it('baseline : la migration acquitte les modèles déjà connus (rejouable), la 1re synchronisation aussi — aucun bandeau', async () => {
    await sql`INSERT INTO ai_model_catalog (provider, model, available, supports_generation) VALUES ('gemini', 'gemini-3.5-flash-lite', TRUE, TRUE)`;
    // Migration 0303 rejouée (idempotente) : modèle connu acquitté, baseline.
    await sql.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/0303_ai_model_catalog_dynamic.sql'), 'utf8'));
    const [m] = await sql<{ baseline: boolean; acknowledged_at: Date | null }[]>`SELECT baseline, acknowledged_at FROM ai_model_catalog WHERE model = 'gemini-3.5-flash-lite'`;
    expect(m.baseline).toBe(true);
    expect(m.acknowledged_at).not.toBeNull();

    const r = await sync(CONNUS);
    expect(r.ok).toBe(true);
    expect(r.baseline).toBe(true);
    const [ref] = await sql<{ baseline_done_at: Date | null }[]>`SELECT baseline_done_at FROM ai_model_catalog_refresh WHERE provider = 'gemini'`;
    expect(ref.baseline_done_at).not.toBeNull();
    expect((await statut()).body.newModels).toEqual([]);
    // Rejouer la migration après la baseline n'acquitte plus rien de nouveau.
    await sql`INSERT INTO ai_model_catalog (provider, model, available, supports_generation) VALUES ('gemini', 'gemini-temoin', TRUE, TRUE)`;
    await sql.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/0303_ai_model_catalog_dynamic.sql'), 'utf8'));
    const [t] = await sql<{ acknowledged_at: Date | null }[]>`SELECT acknowledged_at FROM ai_model_catalog WHERE model = 'gemini-temoin'`;
    expect(t.acknowledged_at).toBeNull();
    await sql`DELETE FROM ai_model_catalog WHERE model = 'gemini-temoin'`;
  });

  it('CAT-01 à CAT-07, CAT-12, CAT-13 — nouveaux modèles via le BOUTON « Actualiser le catalogue » (même fonction que la tâche)', async () => {
    // Google expose trois nouveaux modèles et retire gemini-3.5-flash (repli 1 du code T1/T3/T4).
    const models = [...CONNUS.filter((m) => m !== 'gemini-3.5-flash'),
      { name: 'gemini-9-flash', displayName: 'Gemini 9 Flash' }, { name: 'gemini-9-pro-preview', displayName: 'Gemini 9 Pro Preview' }, 'gemini-9-flash-exp'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => (String(url).includes('pricing')
      ? new Response(PAGE, { status: 200 })
      : new Response(JSON.stringify(listing(models)), { status: 200 }))) as never);
    const { setAiProvider, getAiProvider } = await import('@/services/ai/gateway/providers');
    const avant = getAiProvider();
    setAiProvider({ name: 'gemini', isConfigured: () => true, call: qualifOk as never });
    try {
      const { POST } = await import('@/app/api/admin/ai/provider/catalog/route');
      const { NextRequest } = await import('next/server');
      const res = await POST(new NextRequest('http://app.test/api/admin/ai/provider/catalog', { method: 'POST', body: '{}' }));
      const body = await res.json() as Record<string, any>;
      expect(res.status).toBe(200);
      // CAT-02 — découverte.
      expect(body.discovered.sort()).toEqual(['gemini-9-flash', 'gemini-9-flash-exp', 'gemini-9-pro-preview']);
      expect(body.disappeared).toEqual(['gemini-3.5-flash']);
    } finally {
      fetchSpy.mockRestore();
      setAiProvider(avant);
    }
    const rows = await sql<{ model: string; lifecycle: string; first_seen_at: Date; last_checked_at: Date | null; disappeared_at: Date | null; available: boolean }[]>`
      SELECT model, lifecycle, first_seen_at, last_checked_at, disappeared_at, available FROM ai_model_catalog ORDER BY model`;
    const par = Object.fromEntries(rows.map((r) => [r.model, r]));
    expect(par['gemini-9-pro-preview'].lifecycle).toBe('preview');
    expect(par['gemini-9-flash-exp'].lifecycle).toBe('experimental');
    expect(par['gemini-9-flash'].last_checked_at).not.toBeNull();
    expect(par['gemini-3.5-flash']).toMatchObject({ available: false });
    expect(par['gemini-3.5-flash'].disappeared_at).not.toBeNull();

    // CAT-03 — qualification automatique (avec l'empreinte de la clé active), jamais sur l'expérimental.
    const q = await sql<{ model: string; generate_ok: boolean; structured_ok: boolean; multimodal_ok: boolean }[]>`SELECT model, generate_ok, structured_ok, multimodal_ok FROM ai_model_qualification ORDER BY model`;
    expect(q.find((x) => x.model === 'gemini-9-flash')).toMatchObject({ generate_ok: true, structured_ok: true, multimodal_ok: true });
    expect(q.some((x) => x.model === 'gemini-9-flash-exp')).toBe(false);

    // CAT-04/05/06 — proposés aux traitements compatibles, preview compris, sans tarif compris.
    const cat = await catalogues();
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T5'] as const) {
      const liste = (cat.body.modelsByTreatment[t] as Array<{ model: string }>).map((m) => m.model);
      expect(liste, t).toEqual(expect.arrayContaining(['gemini-9-flash', 'gemini-9-pro-preview']));
      // CAT-12 / CAT-13.
      expect(liste, t).not.toContain('gemini-9-flash-exp');
      expect(liste, t).not.toContain('gemini-3.5-flash');
    }
    const t2 = cat.body.modelsByTreatment.T2 as Array<{ model: string; status: string; priced: boolean }>;
    expect(t2.find((m) => m.model === 'gemini-9-pro-preview')).toMatchObject({ status: 'preview', priced: false });
    expect(t2.find((m) => m.model === 'gemini-9-flash')).toMatchObject({ priced: false });

    // CAT-07 — tarif UNKNOWN, jamais inventé (catalogue tarifaire et registre du BO).
    const [p] = await sql<{ status: string; input_per_million: string | null; reason: string }[]>`SELECT status, input_per_million, reason FROM ai_model_price_status WHERE model = 'gemini-9-flash'`;
    expect(p).toMatchObject({ status: 'UNKNOWN', input_per_million: null, reason: 'absent de la page tarifaire officielle' });
    const [connu] = await sql<{ status: string; input_per_million: string }[]>`SELECT status, input_per_million FROM ai_model_price_status WHERE model = 'gemini-3.6-flash'`;
    expect(connu).toMatchObject({ status: 'KNOWN' });
    expect(Number(connu.input_per_million)).toBe(1.5);
    const reg = await get('/api/admin/ai/model-registry', import('@/app/api/admin/ai/model-registry/route') as never);
    const vue = (reg.body.models as Array<{ model: string; pricing: { status: string }; status: string; price: unknown }>).find((m) => m.model === 'gemini-9-flash')!;
    expect(vue).toMatchObject({ pricing: { status: 'UNKNOWN' }, price: null });
    expect((reg.body.models as Array<{ model: string; status: string }>).find((m) => m.model === 'gemini-9-pro-preview')?.status).toBe('preview');
  });

  it('CAT-13/CAT-14 — modèle ACTIF retiré : alerte d’exploitation, anomalie visible au BO, configuration jamais modifiée', async () => {
    const alertes = await sql<{ treatment: string; message: string; details: { model: string; rank: string } }[]>`
      SELECT treatment, message, details FROM ai_alerts WHERE code = 'ai_active_model_unavailable' ORDER BY treatment`;
    expect(alertes.length).toBeGreaterThan(0);
    expect(alertes.every((a) => a.details.model === 'gemini-3.5-flash' && a.details.rank === 'fallback1')).toBe(true);
    expect(alertes[0].message).toMatch(/Aucun remplacement automatique/);
    const s = await statut();
    expect((s.body.anomalies as Array<{ model: string }>).map((a) => a.model)).toContain('gemini-3.5-flash');
    // Aucune version de configuration créée ni modifiée ; la chaîne du code reste celle d'origine.
    expect(JSON.stringify(await sql`SELECT id, status, updated_at FROM ai_config_versions ORDER BY id`)).toBe(versionsAvant);
    const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
    expect(AI_OPERATIONS.t3_value_conflict.fallbackModels[0]).toBe('gemini-3.5-flash');
  });

  it('CAT-08 à CAT-10 — bandeau des nouveaux modèles : une action acquitte tout, persistant après reconnexion', async () => {
    const s = await statut();
    expect(s.status).toBe(200);
    expect((s.body.newModels as Array<{ model: string }>).map((m) => m.model).sort()).toEqual(['gemini-9-flash', 'gemini-9-pro-preview']);
    expect(s.body.banner.title).toBe('2 nouveaux modèles Gemini sont disponibles');
    const ack = await acquitter(['gemini-9-flash', 'gemini-9-pro-preview']);
    expect(ack.body.acknowledged.sort()).toEqual(['gemini-9-flash', 'gemini-9-pro-preview']);
    // « Reconnexion » : autre administrateur, modules rechargés — l'état vient de la base.
    const autre = await make.user({ role: 'ADMIN' });
    session.adminId = autre.id;
    vi.resetModules();
    expect((await statut()).body.newModels).toEqual([]);
    const [r] = await sql<{ acknowledged_by: number }[]>`SELECT acknowledged_by FROM ai_model_catalog WHERE model = 'gemini-9-flash'`;
    expect(r.acknowledged_by).not.toBe(autre.id);
  });

  it('CAT-11 — un nouveau modèle ultérieur (tâche planifiée) rouvre un bandeau, pour lui seul', async () => {
    const r = await sync([...CONNUS.filter((m) => m !== 'gemini-3.5-flash'), 'gemini-9-flash', 'gemini-9-pro-preview', 'gemini-9-flash-exp', { name: 'gemini-9-ultra', displayName: 'Gemini 9 Ultra' }]);
    expect(r.catalog.discovered).toEqual(['gemini-9-ultra']);
    const s = await statut();
    expect((s.body.newModels as Array<{ model: string }>).map((m) => m.model)).toEqual(['gemini-9-ultra']);
    expect(s.body.banner).toEqual({ title: 'Nouveau modèle Gemini disponible', body: 'Gemini 9 Ultra est désormais disponible et a été ajouté aux modèles utilisables.' });
  });

  it('CAT-15 — changement de tarif : historisé (ancienne / nouvelle valeur, date) ; coût passé jamais revalorisé', async () => {
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    const { recordCallTrace } = await import('@/services/ai/telemetry/ai-trace.service');
    const { loadPricingCache } = await import('@/services/ai/gateway/pricing/pricing.repository');
    await loadPricingCache();
    const avant = calcCostMicros('gemini-3.6-flash', 1_000_000, 100_000)!;
    expect(avant).toBe(1_500_000 + 750_000);
    const traceId = crypto.randomUUID();
    await recordCallTrace({
      traceId, useCaseCode: 'AI_GOVERNANCE', operationCode: 'model_operational_probe', accountId: null, provider: 'gemini', model: 'gemini-3.6-flash',
      promptVersion: 'e2e', usedFallback: false, inputTokens: 1_000_000, outputTokens: 100_000, costMicros: avant, durationMs: 1, status: 'success', billable: false, shadow: false,
    });
    const nouvellePage = PAGE.replace('| Input price | Free of charge | $1.50 |', '| Input price | Free of charge | $2.00 |');
    const r = await sync([...CONNUS.filter((m) => m !== 'gemini-3.5-flash'), 'gemini-9-flash'], async () => nouvellePage);
    expect(r.pricing.changed).toBeGreaterThanOrEqual(1);
    const [ch] = await sql<{ old_input: string; new_input: string; old_output: string; new_output: string; detected_at: Date }[]>`
      SELECT old_input, new_input, old_output, new_output, detected_at FROM ai_model_price_changes
       WHERE model = 'gemini-3.6-flash' AND old_input IS NOT NULL ORDER BY id DESC LIMIT 1`;
    expect([Number(ch.old_input), Number(ch.new_input), Number(ch.old_output), Number(ch.new_output)]).toEqual([1.5, 2, 7.5, 7.5]);
    expect(Number.isNaN(new Date(String(ch.detected_at)).getTime())).toBe(false);
    // Nouveau tarif appliqué aux appels suivants seulement.
    expect(calcCostMicros('gemini-3.6-flash', 1_000_000, 100_000)).toBe(2_000_000 + 750_000);
    const [ev] = await sql<{ cost_micros: string; pricing: { inputMicros: number } | null }[]>`
      SELECT cost_micros, metadata->'pricing' AS pricing FROM ai_usage_event WHERE metadata->>'traceId' = ${traceId}`;
    expect(Number(ev.cost_micros)).toBe(avant);
    // Deux lignes de tarif : l'historique est conservé.
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_model_pricing WHERE model = 'gemini-3.6-flash'`;
    expect(n).toBe(2);
  });

  it('CAT-07 — correspondance devenue ambiguë : tarif retiré (UNKNOWN), coût non calculable, historique intact', async () => {
    const ambigue = `${PAGE}\n## Doublon\n\n*[\`gemini-3.6-flash\`](x)*\n\n|  | Free | Paid |\n|---|---|---|\n| Input price | Free | $9.00 |\n| Output price | Free | $9.00 |\n`;
    await sync([...CONNUS.filter((m) => m !== 'gemini-3.5-flash'), 'gemini-9-flash'], async () => ambigue);
    const [st] = await sql<{ status: string; reason: string }[]>`SELECT status, reason FROM ai_model_price_status WHERE model = 'gemini-3.6-flash'`;
    expect(st).toMatchObject({ status: 'UNKNOWN', reason: expect.stringMatching(/plusieurs sections/) });
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(calcCostMicros('gemini-3.6-flash', 1000, 100)).toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_model_pricing WHERE model = 'gemini-3.6-flash' AND invalidated_at IS NOT NULL`;
    expect(n).toBe(2);
    // Le modèle reste utilisable (le tarif n'est jamais un motif de refus).
    expect((((await catalogues()).body.modelsByTreatment.T3) as Array<{ model: string }>).map((m) => m.model)).toContain('gemini-3.6-flash');
    // Page à nouveau certaine : tarif rétabli (nouvelle ligne, historique conservé).
    await sync([...CONNUS.filter((m) => m !== 'gemini-3.5-flash'), 'gemini-9-flash'], async () => PAGE);
    expect(calcCostMicros('gemini-3.6-flash', 1_000_000, 0)).toBe(1_500_000);
  });

  it('CAT-16 — source tarifaire en panne : tarifs connus conservés, modèles qualifiés utilisables, démarrage jamais bloqué', async () => {
    const r = await sync([...CONNUS.filter((m) => m !== 'gemini-3.5-flash'), 'gemini-9-flash'], async () => { throw new Error('ECONNREFUSED ai.google.dev'); });
    expect(r.ok).toBe(true);
    expect(r.pricing).toMatchObject({ status: 'failed', sourceRead: false });
    const { calcCostMicros, assertPricingReady } = await import('@/services/ai/gateway/cost-catalog');
    expect(calcCostMicros('gemini-3.6-flash', 1_000_000, 0)).toBe(1_500_000);
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_alerts WHERE code = 'ai_pricing_source_unreadable'`;
    expect(n).toBe(1);
    expect(((await catalogues()).body.modelsByTreatment.T2 as Array<{ model: string }>).map((m) => m.model)).toContain('gemini-9-flash');
    const env = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    try {
      await expect(assertPricingReady()).resolves.toBeUndefined();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = env;
    }
  });

  it('une seule implémentation : la tâche planifiée `ai-catalog-sync` appelle la même fonction ; un passage concurrent est ignoré', async () => {
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const src = findTask('ai-catalog-sync')!.run.toString();
    expect(src).toMatch(/syncAiCatalog/);
    const routeSrc = readFileSync(join(process.cwd(), 'src/app/api/admin/ai/provider/catalog/route.ts'), 'utf8');
    expect(routeSrc).toMatch(/syncAiCatalog\(\{ trigger: 'manual'/);
    expect(routeSrc).not.toMatch(/refreshModelCatalog\(/);
    const { acquireJobLock, releaseJobLock } = await import('@/lib/job-lock');
    const h = await acquireJobLock('ai-catalog-sync', 60_000);
    try {
      const { syncAiCatalog } = await import('@/services/ai/provider/ai-catalog-sync.service');
      expect((await syncAiCatalog({ trigger: 'manual' }, { fetcher: fetcherDe(CONNUS) })).skipped).toBe(true);
    } finally {
      if (h) await releaseJobLock(h);
    }
  });
});
