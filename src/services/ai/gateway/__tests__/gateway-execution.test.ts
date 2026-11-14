/**
 * Passerelle — lot IA 2 : rang du modèle tracé (§9.1, CST-UI-05, LOG-UI-05),
 * niveau de raisonnement par rang (T1-UI-06, T2-UI-03, T3-UI-03, T4-UI-03),
 * configuration figée par exécution (VER-015), job parent tracé, coût réel
 * des appels échoués (COST-005) et coût non inventé (COST-008).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', () => ({
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { AiGateway, rankAt } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { primePricingCache, clearPricingCache, __setVerifiedTestPricesForTests } = await import('../pricing/pricing.repository');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { runInJobContext } = await import('../../queue/job-context');
const { emptyTreatmentConfig } = await import('../../config/config-types');

// Lot 16b-3 : opération T1 réelle (branche GROUP_UPLOAD du master).
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');
const Schema = t1Schema({ ok: z.boolean() });
const OK = t1Out({ ok: true });
let fake: InstanceType<typeof FakeProvider>;

const PRIX = (model: string) => ({
  provider: 'gemini', model, inputMicros: 0.1, outputMicros: 0.4, currency: 'USD',
  source: 'manual' as const, verified: true, fetchedAt: new Date(),
});

function t1(primary: string, f1: string | null, f2: string | null, reasoning: Array<'minimal' | 'standard' | 'étendu' | null>) {
  return {
    ...emptyTreatmentConfig('T1'),
    primaryModel: primary, fallback1: f1, fallback2: f2,
    reasoningPrimary: reasoning[0] ?? null, reasoningFallback1: reasoning[1] ?? null, reasoningFallback2: reasoning[2] ?? null,
  };
}

const req = () => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const,
  operationCode: T1_TEST_OPERATION,
  accountId: 1,
  promptVariables: t1TestVariables(),
  outputSchema: Schema,
  idempotencyKey: `k-${Math.random()}`,
});

beforeEach(() => {
  traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  clearPricingCache();
  primePricingCache([PRIX('m-a'), PRIX('m-b'), PRIX('m-c')]);
});
afterEach(() => __setConfigForTests(null));

describe('rang du modèle réellement utilisé', () => {
  it('indice de chaîne → rang', () => {
    expect([rankAt(0), rankAt(1), rankAt(2), rankAt(3)]).toEqual(['primary', 'fallback_1', 'fallback_2', null]);
  });

  it('trace primary, fallback_1 puis fallback_2 — jamais NULL pour un repli', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b', 'm-c', [])] });
    // Lot 87A : indisponibilité 503 explicite (panne propre au modèle → secours).
    fake.on('m-a', () => { throw Object.assign(new Error('503'), { status: 503 }); });
    fake.on('m-b', () => { throw Object.assign(new Error('503'), { status: 503 }); });
    fake.on('m-c', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-c');
    expect(traces.map((t) => t.modelRank)).toEqual(['primary', 'fallback_1', 'fallback_2']);
    expect(traces.every((t) => t.configVersionId === 1)).toBe(true);
  });
});

describe('niveau de raisonnement par rang', () => {
  it('transmet le niveau du rang sollicité au fournisseur', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b', null, ['minimal', 'étendu'])] });
    fake.on('m-a', () => { throw new Error('503'); });
    fake.on('m-b', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    expect(fake.calls.map((c) => [c.model, c.reasoning])).toEqual([['m-a', 'minimal'], ['m-b', 'étendu']]);
  });

  it('un fallback 1 absent : le niveau du fallback 2 suit son modèle', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', null, 'm-c', ['standard', 'minimal', 'étendu'])] });
    fake.on('m-a', () => { throw new Error('503'); });
    fake.on('m-c', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    expect(fake.calls.map((c) => [c.model, c.reasoning])).toEqual([['m-a', 'standard'], ['m-c', 'étendu']]);
  });

  it('sans version : aucun niveau transmis (défaut du modèle)', async () => {
    fake.onAny(() => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    expect(fake.calls[0].reasoning ?? null).toBeNull();
  });
});

describe('configuration figée par exécution (VER-015)', () => {
  it("une exécution de file garde la version de son démarrage, même si l'Active change", async () => {
    // Effective = v2 ; le job a démarré sous v1.
    __setConfigForTests(
      { versionId: 2, entries: [t1('m-b', null, null, [])] },
      [{ versionId: 1, entries: [t1('m-a', null, null, [])] }],
    );
    fake.onAny(() => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await runInJobContext({ jobId: 77, treatment: 'T1', configVersionId: 1 }, () => AiGateway.execute(req()));
    expect(fake.calls[0].model).toBe('m-a');
    expect(traces[0]).toMatchObject({ configVersionId: 1, jobId: 77 });

    // Hors exécution : la version effective.
    await AiGateway.execute(req());
    expect(fake.calls[1].model).toBe('m-b');
    expect(traces[1]).toMatchObject({ configVersionId: 2, jobId: null });
  });

  it('aucune version au démarrage : le code jusqu’au bout, même si une version est activée', async () => {
    __setConfigForTests({ versionId: 2, entries: [t1('m-b', null, null, [])] });
    fake.onAny(() => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await runInJobContext({ jobId: 5, treatment: 'T1', configVersionId: null }, () => AiGateway.execute(req()));
    expect(fake.calls[0].model).not.toBe('m-b');
    expect(traces[0].configVersionId).toBeNull();
  });
});

describe('coûts des appels', () => {
  it('COST-005 : une sortie rejetée garde ses jetons et son coût réels', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', null, null, [])] });
    fake.on('m-a', () => ({ rawText: '{"pas":"conforme"}', inputTokens: 1000, outputTokens: 500 }));
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(traces[0]).toMatchObject({ status: 'error', inputTokens: 1000, outputTokens: 500, errorCode: 'INVALID_OUTPUT' });
    expect(Number(traces[0].costMicros)).toBeGreaterThan(0);
  });

  // Lot 114 (Trello #770) — règle remplacée : « modèle sans tarif → appelé, coût NULL » (COST-008).
  describe('#770 — aucun appel sans tarif officiel vérifié', () => {
    beforeEach(() => __setVerifiedTestPricesForTests(false));

    it('R05 — principal sans tarif, repli tarifé : seul le repli configuré est appelé ; rang sauté tracé MODEL_PRICING_UNVERIFIED, coût 0, aucune requête', async () => {
      __setConfigForTests({ versionId: 1, entries: [t1('sans-tarif', 'm-b', null, [])] });
      let appelsSansTarif = 0; let appelsRepli = 0;
      fake.on('sans-tarif', () => { appelsSansTarif++; return { rawText: OK, inputTokens: 10, outputTokens: 10 }; });
      fake.on('m-b', () => { appelsRepli++; return { rawText: OK, inputTokens: 10, outputTokens: 10 }; });
      const r = await AiGateway.execute(req());
      expect([appelsSansTarif, appelsRepli]).toEqual([0, 1]);
      expect(r.model).toBe('m-b');
      expect(traces[0]).toMatchObject({ model: 'sans-tarif', status: 'error', errorCode: 'MODEL_PRICING_UNVERIFIED', billable: false, inputTokens: 0, outputTokens: 0, costMicros: 0, modelRank: 'primary' });
      expect(String(traces[0].errorMessage)).toMatch(/sans-tarif non sollicité : modèle sans tarif officiel vérifié : non appelé \(aucun tarif officiel connu\)/);
      expect(traces[1]).toMatchObject({ model: 'm-b', status: 'success' });
    });

    it('R05 — aucun rang tarifé : aucun appel fournisseur, suspension explicite (jamais un faux succès)', async () => {
      __setConfigForTests({ versionId: 1, entries: [t1('sans-tarif', 'sans-tarif-2', 'sans-tarif-3', [])] });
      let appels = 0;
      for (const m of ['sans-tarif', 'sans-tarif-2', 'sans-tarif-3']) fake.on(m, () => { appels++; return { rawText: OK, inputTokens: 10, outputTokens: 10 }; });
      await expect(AiGateway.execute(req())).rejects.toMatchObject({ name: 'AiSuspendedError' });
      expect(appels).toBe(0);
      expect(traces.map((t) => t.errorCode)).toEqual(['MODEL_PRICING_UNVERIFIED', 'MODEL_PRICING_UNVERIFIED', 'MODEL_PRICING_UNVERIFIED']);
      expect(traces.every((t) => t.costMicros === 0 && t.billable === false)).toBe(true);
    });

    it('R03 — tarif connu mais non confirmé (amorçage embarqué, saisie manuelle non confirmée, périmé) : non appelé ; tarif officiel de 0 : appelé', async () => {
      const base = { provider: 'gemini', inputMicros: 1, outputMicros: 2, currency: 'USD', fetchedAt: new Date() };
      primePricingCache([
        { ...base, model: 'amorce', source: 'public_catalog', verified: false },
        { ...base, model: 'manuel', source: 'manual', verified: false },
        { ...base, model: 'perime', source: 'public_catalog', verified: false, pageStatus: 'STALE', staleSince: new Date(Date.now() - 400 * 86_400_000) },
        { ...base, model: 'gratuit', source: 'public_catalog', verified: false, inputMicros: 0, outputMicros: 0, pageStatus: 'KNOWN' },
      ]);
      let appels: string[] = [];
      for (const m of ['amorce', 'manuel', 'perime', 'gratuit']) fake.on(m, () => { appels.push(m); return { rawText: OK, inputTokens: 10, outputTokens: 10 }; });
      __setConfigForTests({ versionId: 1, entries: [t1('amorce', 'manuel', 'perime', [])] });
      await expect(AiGateway.execute(req())).rejects.toMatchObject({ name: 'AiSuspendedError' });
      expect(appels).toEqual([]);
      traces.length = 0; appels = [];
      __setConfigForTests({ versionId: 1, entries: [t1('gratuit', null, null, [])] });
      const r = await AiGateway.execute(req());
      expect(appels).toEqual(['gratuit']);
      expect(r.costMicros).toBe(0);
      expect(traces[0]).toMatchObject({ model: 'gratuit', status: 'success', costMicros: 0 });
    });
  });
});
