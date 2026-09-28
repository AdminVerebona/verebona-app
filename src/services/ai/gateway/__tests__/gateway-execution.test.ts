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
const { primePricingCache, clearPricingCache } = await import('../pricing/pricing.repository');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { runInJobContext } = await import('../../queue/job-context');
const { emptyTreatmentConfig } = await import('../../config/config-types');

const Schema = z.object({ ok: z.boolean() });
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
  operationCode: 'classify_document',
  accountId: 1,
  promptVariables: {},
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
    fake.on('m-a', () => { throw new Error('503'); });
    fake.on('m-b', () => { throw new Error('503'); });
    fake.on('m-c', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
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
    fake.on('m-b', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    expect(fake.calls.map((c) => [c.model, c.reasoning])).toEqual([['m-a', 'minimal'], ['m-b', 'étendu']]);
  });

  it('un fallback 1 absent : le niveau du fallback 2 suit son modèle', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', null, 'm-c', ['standard', 'minimal', 'étendu'])] });
    fake.on('m-a', () => { throw new Error('503'); });
    fake.on('m-c', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    expect(fake.calls.map((c) => [c.model, c.reasoning])).toEqual([['m-a', 'standard'], ['m-c', 'étendu']]);
  });

  it('sans version : aucun niveau transmis (défaut du modèle)', async () => {
    fake.onAny(() => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
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
    fake.onAny(() => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
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
    fake.onAny(() => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
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

  it('COST-008 : modèle sans tarif → coût NULL, jamais 0', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('sans-tarif', null, null, [])] });
    fake.on('sans-tarif', () => ({ rawText: '{"ok":true}', inputTokens: 10, outputTokens: 10 }));
    const r = await AiGateway.execute(req());
    expect(traces[0].costMicros).toBeNull();
    // La réponse métier reste numérique : l'appelant n'a pas à gérer NULL.
    expect(r.costMicros).toBe(0);
  });
});
