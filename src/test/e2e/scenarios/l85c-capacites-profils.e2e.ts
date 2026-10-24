/**
 * Lot 85C sur PostgreSQL 16 réel — CDC Pilotage IA V2, phase P4 « capacités
 * et profils par opération » (CAT-01..03, CFG-01..03, R01-R03, R33-R35, R45,
 * R46, R69 ; décisions PO 02, 06, 08, 09). Migrations 0708, 0709, 0710.
 *
 *   L85C-E01  catalogue rafraîchi avec l'API Models SIMULÉE : fiches de
 *             capacités figées (source, date), Preview visible pour
 *             information, jamais qualifié ni sondé ni proposé
 *   L85C-E02  nouvelle synchronisation sans changement : rien de marqué,
 *             aucune qualification lancée (R46, pas de requalification par âge)
 *   L85C-E03  capacité modifiée → journal + « requalification nécessaire »
 *             marquée sur événement ; le passage suivant requalifie CE modèle
 *             seulement et efface la marque
 *   L85C-E04  constructeur identique validation / exécution : profils par
 *             opération et par rang enregistrés dans la configuration
 *             versionnée, requête réellement transmise = plan de validation
 *             = profils effectifs du BO ; combinaison incompatible refusée à
 *             l'enregistrement et AVANT appel en exécution (catégorie
 *             explicite dans le journal)
 *   L85C-E05  Preview : activation refusée (décision 02) ; migrations
 *             rejouables (idempotence)
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { scenario } from '../scenario';
import { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } from '@/services/ai/gateway/__tests__/t1-master-request';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l85c@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email, role: 'ADMIN' }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const CLE = 'cle-e2e-l85c';
type ApiModel = { name: string; displayName?: string; outputTokenLimit?: number; thinking?: boolean; maxTemperature?: number; temperature?: number };
const BASE: ApiModel[] = [
  { name: 'gemini-3.6-flash', outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2 },
  { name: 'gemini-3.5-flash-lite', outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2 },
  { name: 'gemini-3.1-flash-lite', outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2 },
  { name: 'gemini-3.5-flash', outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2 },
  { name: 'gemini-2.5-flash', outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2 },
  { name: 'gemini-2.5-pro', outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2 },
  // Nouveau modèle stable, raisonnement annoncé sans réglage documenté.
  { name: 'gemini-9-flash', displayName: 'Gemini 9 Flash', outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2 },
  // Modèle sans raisonnement.
  { name: 'gemini-9-texte', displayName: 'Gemini 9 Texte', outputTokenLimit: 65_536, thinking: false, temperature: 1, maxTemperature: 2 },
  // Preview : information seulement (décision 02).
  { name: 'gemini-9-pro-preview', displayName: 'Gemini 9 Pro Preview', outputTokenLimit: 65_536, thinking: true, temperature: 1, maxTemperature: 2 },
];
const listing = (models: ApiModel[]) => ({
  models: models.map((m) => ({
    name: `models/${m.name}`, displayName: m.displayName, supportedGenerationMethods: ['generateContent', 'countTokens'],
    inputTokenLimit: 1_048_576, outputTokenLimit: m.outputTokenLimit, thinking: m.thinking, temperature: m.temperature, maxTemperature: m.maxTemperature,
  })),
});
const fetcherDe = (models: ApiModel[]) => (async () => new Response(JSON.stringify(listing(models)), { status: 200 })) as unknown as typeof fetch;
const avec = (over: Partial<ApiModel> & { name: string }) => BASE.map((m) => (m.name === over.name ? { ...m, ...over } : m));

/** Épreuves de qualification simulées (tout réussit) — modèles reçus relevés. */
const qualif = vi.fn(async (i: { model: string; responseSchema?: unknown; attachments: unknown[] }) => ({
  rawText: i.responseSchema ? '{"ok":true,"mot":"verebona"}' : i.attachments.length ? 'Rouge' : 'OK', inputTokens: 4, outputTokens: 2,
}));
const sondes: string[] = [];
const sonde = async (model: string) => { sondes.push(model); return { rawText: 'OK' }; };

scenario('L85C', 'Capacités des modèles et profils par opération (Pilotage IA V2 P4)', ({ sql, make }) => {
  let adminId = 0;
  let env = 'local';
  let activeAvant: number[] = [];

  async function sync(models: ApiModel[]) {
    const { syncAiCatalog } = await import('@/services/ai/provider/ai-catalog-sync.service');
    return syncAiCatalog({ trigger: 'schedule' }, {
      fetcher: fetcherDe(models), qualificationCall: qualif as never, probeCall: sonde, maxQualifications: 50,
      pricing: { fetchPage: async () => { throw new Error('hors ligne'); }, billing: null },
      raiseAlert: async () => false,
    });
  }
  async function get(path: string, mod: Promise<{ GET: (r: never) => Promise<Response> }>) {
    const { NextRequest } = await import('next/server');
    const res = await (await mod).GET(new NextRequest(`http://app.test${path}`) as never);
    return { status: res.status, body: await res.json() as Record<string, any> };
  }
  const capacites = (q = '') => get(`/api/admin/ai/model-capabilities${q}`, import('@/app/api/admin/ai/model-capabilities/route') as never);
  const catalogues = () => get('/api/admin/ai/config-catalogs', import('@/app/api/admin/ai/config-catalogs/route') as never);
  const journal = async () => sql<{ model: string; trigger: string; requalification_marked: boolean; changes: Array<{ field: string }> }[]>`
    SELECT model, trigger, requalification_marked, changes FROM ai_model_capability_changes ORDER BY id`;

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    adminId = admin.id;
    session.adminId = admin.id;
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_capability_changes', 'ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    env = (await import('@/services/ai/config/environment')).getAiEnvironment();
    activeAvant = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id));
  });

  afterAll(async () => {
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(null);
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = ${env} AND status = 'ACTIVE'`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE', deleted_at = NULL WHERE id = ANY(${activeAvant})`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    for (const t of ['ai_model_capability_changes', 'ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    (await import('@/services/ai/provider/model-capabilities.repository')).invalidateModelCapabilities();
  });

  it('L85C-E01 — API Models simulée : fiches de capacités figées (source, date) ; Preview visible, jamais qualifié, sondé ni proposé', async () => {
    const r = await sync(BASE);
    expect(r.ok).toBe(true);
    expect(r.capabilities?.checked).toBe(BASE.length);
    // Première synchronisation : fiches de base, aucun événement de requalification.
    expect(r.capabilities?.requalificationMarked).toEqual([]);
    const fiches = await sql<{ model: string; capabilities: any; capabilities_sha256: string | null; capabilities_checked_at: Date | null }[]>`
      SELECT model, capabilities, capabilities_sha256, capabilities_checked_at FROM ai_model_catalog ORDER BY model`;
    expect(fiches).toHaveLength(BASE.length);
    for (const f of fiches) expect(f.capabilities_sha256, f.model).toMatch(/^[0-9a-f]{64}$/);
    const flash25 = fiches.find((f) => f.model === 'gemini-2.5-flash')!.capabilities;
    expect(flash25).toMatchObject({
      family: 'gemini-2.5', thinking: { mode: 'budget' }, outputTokenLimit: 65_536, temperature: { accepted: true, max: 2, providerDefault: 1 },
      sources: { thinking: { source: 'reference' }, outputTokenLimit: { source: 'api' }, temperature: { source: 'api' }, family: { source: 'reference' } },
    });
    expect(fiches.find((f) => f.model === 'gemini-9-flash')!.capabilities).toMatchObject({ family: null, thinking: { mode: 'unknown' } });
    expect(fiches.find((f) => f.model === 'gemini-9-texte')!.capabilities).toMatchObject({ thinking: { mode: 'none' }, sources: { thinking: { source: 'api' } } });
    // Preview : jamais qualifié, jamais sondé (aucun appel).
    expect(qualif.mock.calls.some(([i]) => i.model === 'gemini-9-pro-preview')).toBe(false);
    expect(sondes).not.toContain('gemini-9-pro-preview');
    expect(r.qualification.qualified).toContain('gemini-9-flash');
    // Les constats des sondes complètent les fiches SANS marquer de requalification.
    expect((await journal()).every((j) => j.trigger === 'qualification' && !j.requalification_marked)).toBe(true);
    // BO (Configuration IA) : visible pour information ; jamais proposé aux sélecteurs.
    const bo = await capacites();
    expect(bo.status).toBe(200);
    const preview = (bo.body.capabilities as any[]).find((c) => c.model === 'gemini-9-pro-preview');
    expect(preview).toMatchObject({ informationOnly: true, listed: true });
    expect((bo.body.capabilities as any[]).find((c) => c.model === 'gemini-2.5-flash').capabilities.modalities).toEqual({ imageInput: true, structuredOutput: true });
    const cat = await catalogues();
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T6']) {
      expect((cat.body.modelsByTreatment[t] as Array<{ model: string }>).map((m) => m.model), t).not.toContain('gemini-9-pro-preview');
    }
    expect((cat.body.excludedByTreatment.T1 as Array<{ model: string; reasonText: string }>).find((m) => m.model === 'gemini-9-pro-preview')?.reasonText).toMatch(/Preview/);
    expect((cat.body.operationsByTreatment.T1 as Array<{ operationCode: string }>).map((o) => o.operationCode)).toEqual(['t1_group_upload', 't1_analyze_document']);
  });

  it('L85C-E02 — synchronisation sans changement : rien de marqué, aucune qualification lancée (R46)', async () => {
    const avant = (await journal()).length;
    qualif.mockClear();
    const r = await sync(BASE);
    expect(r.ok).toBe(true);
    expect(r.capabilities).toMatchObject({ changed: [], requalificationMarked: [] });
    expect(qualif).not.toHaveBeenCalled();
    expect(r.qualification).toMatchObject({ qualified: [], failed: [], remaining: 0 });
    expect((await journal()).length).toBe(avant);
    const marques = await sql`SELECT model FROM ai_model_qualification WHERE requalification_required_at IS NOT NULL`;
    expect(marques).toHaveLength(0);
  });

  it('L85C-E03 — capacité modifiée → journal et « requalification nécessaire » sur événement ; requalification ciblée au passage suivant', async () => {
    // a) Le catalogue relit une limite de sortie différente pour gemini-3.6-flash.
    const { refreshModelCatalog } = await import('@/services/ai/provider/model-catalog.service');
    const { recordCapabilitySnapshot } = await import('@/services/ai/provider/model-capabilities.repository');
    expect((await refreshModelCatalog(null, fetcherDe(avec({ name: 'gemini-3.6-flash', outputTokenLimit: 16_384 })))).ok).toBe(true);
    const c = await recordCapabilitySnapshot({ trigger: 'schedule', markRequalification: true });
    expect(c.changed).toEqual(['gemini-3.6-flash']);
    expect(c.requalificationMarked).toEqual(['gemini-3.6-flash']);
    const [q] = await sql<{ requalification_required_at: Date | null; requalification_reason: string | null }[]>`
      SELECT requalification_required_at, requalification_reason FROM ai_model_qualification WHERE model = 'gemini-3.6-flash'`;
    expect(q.requalification_required_at).not.toBeNull();
    expect(q.requalification_reason).toMatch(/outputTokenLimit/);
    const dernier = (await journal()).at(-1)!;
    expect(dernier).toMatchObject({ model: 'gemini-3.6-flash', requalification_marked: true });
    expect(dernier.changes.map((x) => x.field)).toEqual(['outputTokenLimit']);
    const bo = await capacites();
    expect((bo.body.capabilities as any[]).find((x) => x.model === 'gemini-3.6-flash')).toMatchObject({ requalificationReason: expect.stringMatching(/outputTokenLimit/), capabilities: { outputTokenLimit: 16_384 } });
    // La nouvelle limite s'applique aussitôt : l'analyse T1 (plancher 32 768) devient impossible avant appel.
    const { buildModelRequest } = await import('@/services/ai/gateway/request-builder');
    const { ensureModelCapabilitiesLoaded } = await import('@/services/ai/provider/model-capabilities.repository');
    await ensureModelCapabilitiesLoaded();
    expect(buildModelRequest({ model: 'gemini-3.6-flash', minOutputTokens: 32_768 })).toMatchObject({ ok: false, refusal: { parameter: 'generationConfig.maxOutputTokens' } });

    // b) Synchronisation suivante (même relevé) : requalifie CE modèle seulement, marque effacée.
    qualif.mockClear();
    const r = await sync(avec({ name: 'gemini-3.6-flash', outputTokenLimit: 16_384 }));
    expect(r.capabilities?.changed).toEqual([]);
    expect([...new Set(qualif.mock.calls.map(([i]) => i.model))]).toEqual(['gemini-3.6-flash']);
    const [apres] = await sql<{ requalification_required_at: Date | null }[]>`SELECT requalification_required_at FROM ai_model_qualification WHERE model = 'gemini-3.6-flash'`;
    expect(apres.requalification_required_at).toBeNull();
  });

  it('L85C-E04 — même constructeur en validation et en exécution ; incompatibilité refusée à l’enregistrement et avant appel', async () => {
    const svc = await import('@/services/ai/config/config-version.service');
    const repo = await import('@/services/ai/config/config-version.repository');
    const { operationRequestPlan } = await import('@/services/ai/config/profile-check');
    const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l85c profils' });
    const base = v.entries.find((e) => e.treatment === 'T1')!;
    const t1 = {
      ...base, primaryModel: 'gemini-3.5-flash', reasoningPrimary: 'minimal' as const, fallback1: 'gemini-2.5-flash', reasoningFallback1: 'minimal' as const,
      fallback2: null, reasoningFallback2: null, maxOutputTokens: 70_000,
      operationProfiles: { [T1_TEST_OPERATION]: { reasoningByRank: [null, 'étendu' as const], maxOutputTokensByRank: [null, 3000], timeoutMs: 30_000 } },
    };
    await svc.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, entries: [t1] }, adminId);
    const enregistree = (await repo.getVersion(v.id))!;
    const e1 = enregistree.entries.find((e) => e.treatment === 'T1')!;
    expect(e1.operationProfiles).toEqual({ [T1_TEST_OPERATION]: { reasoningByRank: [null, 'étendu'], maxOutputTokensByRank: [null, 3000], timeoutMs: 30_000 } });
    // Profils portés par l'instantané de la révision (configuration versionnée existante).
    const [rev] = await sql<{ snapshot: any }[]>`SELECT snapshot FROM ai_config_revisions WHERE id = ${enregistree.currentRevisionId}`;
    expect(rev.snapshot.entries.find((x: any) => x.treatment === 'T1').operationProfiles[T1_TEST_OPERATION]).toMatchObject({ maxOutputTokensByRank: [null, 3000] });
    await svc.activate(v.id, adminId);

    // Exécution réelle de la passerelle (fournisseur simulé) : principal en panne, repli réussi.
    const { FakeProvider, setAiProvider, getAiProvider } = await import('@/services/ai/gateway/providers');
    const avant = getAiProvider();
    const fake = new FakeProvider();
    fake.on('gemini-3.5-flash', () => { throw Object.assign(new Error('503 UNAVAILABLE'), { status: 503 }); });
    fake.on('gemini-2.5-flash', () => ({ rawText: t1Out({ ok: true }), inputTokens: 5, outputTokens: 2 }));
    setAiProvider(fake);
    const compte = await make.account();
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    try {
      const res = await AiGateway.execute({
        useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: compte.id, promptVariables: t1TestVariables(),
        outputSchema: t1Schema({ ok: z.boolean() }), idempotencyKey: `l85c-e04-${Date.now()}`,
      });
      expect(res.model).toBe('gemini-2.5-flash');
    } finally {
      setAiProvider(avant);
    }
    // Plan de VALIDATION (même constructeur) = requête réellement transmise, rang par rang.
    const plan = operationRequestPlan(e1, AI_OPERATIONS[T1_TEST_OPERATION]);
    expect(fake.calls.map((c) => c.model)).toEqual(['gemini-3.5-flash', 'gemini-2.5-flash']);
    expect(fake.calls[0].generation).toEqual(plan[0].result.ok && plan[0].result.params);
    expect(fake.calls[1].generation).toEqual(plan[1].result.ok && plan[1].result.params);
    expect(fake.calls[0].generation).toEqual({ temperature: 0, maxOutputTokens: 65_536, thinking: { thinkingLevel: 'low' } });
    expect(fake.calls[1].generation).toEqual({ temperature: 0, maxOutputTokens: 3000, thinking: { thinkingBudget: 24_576 } });
    expect(fake.calls.every((c) => c.timeoutMs === 30_000)).toBe(true);
    // Profils effectifs du BO (même plan).
    const bo = await capacites(`?versionId=${v.id}`);
    const lignes = (bo.body.plans.T1 as any[]).filter((p) => p.operationCode === T1_TEST_OPERATION);
    expect(lignes.map((l) => [l.model, l.maxOutputTokens.sent, l.reasoning.sent])).toEqual([['gemini-3.5-flash', 65_536, 'low'], ['gemini-2.5-flash', 3000, 'budget 24576']]);
    expect(lignes[0].adaptations).toContainEqual(expect.objectContaining({ reason: 'MODEL_OUTPUT_LIMIT' }));
    // Trace : demandé / hérité / adapté / envoyé.
    const traces = await sql<{ model: string; metadata: any }[]>`SELECT model, metadata FROM ai_usage_event WHERE account_id = ${compte.id} ORDER BY id`;
    expect(traces.map((t) => t.model)).toEqual(['gemini-3.5-flash', 'gemini-2.5-flash']);
    expect(traces[1].metadata.providerRequest).toMatchObject({ maxOutputTokens: 3000, thinkingConfig: 'budget 24576' });

    // Enregistrement d'une combinaison CONNUE comme incompatible : refusé (modèle sans raisonnement en « étendu »).
    const actuelle = (await repo.getVersion(v.id))!;
    await expect(svc.saveConfiguration(v.id, {
      expectedRevision: actuelle.currentRevisionNumber,
      entries: [{ ...actuelle.entries.find((e) => e.treatment === 'T1')!, fallback2: 'gemini-9-texte', reasoningFallback2: 'étendu' }],
    }, adminId)).rejects.toMatchObject({ code: 'MODEL_PARAMETERS_INCOMPATIBLE' });

    // Capacité devenue incompatible APRÈS l'activation (le repli ne raisonne plus) : refus AVANT appel en exécution.
    await sync(avec({ name: 'gemini-2.5-flash', thinking: false }));
    const fake2 = new FakeProvider();
    fake2.on('gemini-3.5-flash', () => { throw Object.assign(new Error('503 UNAVAILABLE'), { status: 503 }); });
    fake2.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    setAiProvider(fake2);
    const compte2 = await make.account();
    try {
      await expect(AiGateway.execute({
        useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: compte2.id, promptVariables: t1TestVariables(),
        outputSchema: t1Schema({ ok: z.boolean() }), idempotencyKey: `l85c-e04b-${Date.now()}`,
      })).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'MODEL_PARAMETERS_INCOMPATIBLE' });
    } finally {
      setAiProvider(avant);
    }
    expect(fake2.calls.map((c) => c.model)).toEqual(['gemini-3.5-flash']);
    // Journal (BO › Exécutions & logs, vue technique) : catégorie explicite, jamais « fournisseur indisponible ».
    const j = await get(`/api/admin/ai/executions?accountId=${compte2.id}&errorsOnly=1`, import('@/app/api/admin/ai/executions/route') as never);
    const refus = (j.body.rows ?? j.body.items ?? j.body.executions ?? []).find((x: any) => x.model === 'gemini-2.5-flash');
    expect(refus).toMatchObject({ errorCode: 'MODEL_PARAMETERS_INCOMPATIBLE', failure: { family: 'INPUT_ERROR', subtype: 'PARAMETER_INCOMPATIBLE' } });
    const [ligne] = await sql<{ error_code: string; input_tokens: number; metadata: any }[]>`
      SELECT error_code, input_tokens, metadata FROM ai_usage_event WHERE account_id = ${compte2.id} AND model = 'gemini-2.5-flash'`;
    expect(ligne).toMatchObject({ error_code: 'MODEL_PARAMETERS_INCOMPATIBLE', input_tokens: 0 });
    expect(ligne.metadata.failure).toMatchObject({ parameter: 'generationConfig.thinkingConfig' });
  });

  it('L85C-E05 — Preview : nouvelle activation refusée (décision 02) ; migrations 0708-0710 rejouables', async () => {
    const svc = await import('@/services/ai/config/config-version.service');
    const repo = await import('@/services/ai/config/config-version.repository');
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l85c preview' });
    // Valeur Preview écrite hors de l'écran (le BO ne la propose pas) : l'activation la refuse.
    await sql`UPDATE ai_config_entries SET fallback_2 = 'gemini-9-pro-preview' WHERE version_id = ${v.id} AND treatment = 'T2'`;
    await expect(svc.activate(v.id, adminId)).rejects.toMatchObject({ code: 'MODEL_NOT_USABLE' });
    expect((await repo.getActiveVersion(env as never))?.id ?? null).not.toBe(v.id);
    // Même refus pour une RÉACTIVATION (contrôles techniques conservés, décision 06).
    await sql`UPDATE ai_config_versions SET activated_at = NOW() - INTERVAL '1 day' WHERE id = ${v.id}`;
    await expect(svc.activate(v.id, adminId)).rejects.toMatchObject({ code: 'TECHNICAL_CHECK_FAILED' });

    for (const f of ['0708_l85c_capacites_modeles.sql', '0709_l85c_journal_capacites.sql', '0710_l85c_profils_operations.sql']) {
      await sql.begin(async (tx) => { await tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations', f), 'utf8')); });
    }
    const [n] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ai_model_capability_changes`;
    expect(n.n).toBeGreaterThan(0);
  });
});
