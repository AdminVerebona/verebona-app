/**
 * CDC 15 CFG-02, CFG-05, ARCH-03, DP-05, OBS-CFG — la trace porte ce qui a
 * RÉELLEMENT été appliqué : TASK et prompt maître, niveau de raisonnement du
 * rang sollicité, plafond de sortie, moteur (legacy/new) et déclencheur.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { runInJobContext } = await import('../../queue/job-context');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { configMetadata } = await import('../../telemetry/ai-trace.service');

const Schema = z.object({ ok: z.boolean() });
let fake: InstanceType<typeof FakeProvider>;

const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const,
  operationCode: 'classify_document',
  accountId: 1,
  promptVariables: {},
  outputSchema: Schema,
  idempotencyKey: `k-${Math.random()}`,
  ...over,
});

beforeEach(() => {
  traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
});
afterEach(() => __setConfigForTests(null));

describe('trace de la configuration appliquée', () => {
  it('raisonnement du rang, plafond, moteur new, TASK et master, déclencheur du job', async () => {
    __setConfigForTests({
      versionId: 5,
      entries: [{
        ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: 'm-b', fallback2: null,
        reasoningPrimary: 'minimal', reasoningFallback1: 'étendu', maxOutputTokens: 4096,
      }],
    });
    fake.on('m-a', () => { throw new Error('503'); });
    fake.on('m-b', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));

    await runInJobContext(
      { jobId: 12, treatment: 'T1', configVersionId: 5, triggerCode: 'source_uploaded' },
      () => AiGateway.execute(req({ task: 'ANALYZE_DOCUMENT', masterPromptCode: 't1_master', masterPromptVersion: '1' })),
    );

    expect(traces.map((t) => [t.model, t.reasoning, t.maxOutputTokens])).toEqual([
      ['m-a', 'minimal', 4096], ['m-b', 'étendu', 4096],
    ]);
    for (const t of traces) {
      expect(t).toMatchObject({
        engine: 'new', triggerCode: 'source_uploaded',
        task: 'ANALYZE_DOCUMENT', masterPromptCode: 't1_master', masterPromptVersion: '1',
      });
    }
  });

  it('escalade explicite : le niveau envoyé est celui du rang sollicité, pas du principal', async () => {
    __setConfigForTests({
      versionId: 6,
      entries: [{
        ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: 'm-b', fallback2: null,
        reasoningPrimary: 'minimal', reasoningFallback1: 'étendu',
      }],
    });
    fake.on('m-b', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req({ firstModelIndex: 1 }));
    expect(fake.calls.map((c) => [c.model, c.reasoning])).toEqual([['m-b', 'étendu']]);
    expect(traces[0]).toMatchObject({ reasoning: 'étendu', modelRank: 'fallback_1' });
  });

  it('prompt historique relayé → moteur legacy ; appel hors job → aucun déclencheur', async () => {
    const { getOperation } = await import('../../registry/operations');
    fake.on(getOperation('legacy_document_analysis').primaryModel, () => ({ rawText: 'texte libre', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'legacy_document_analysis', accountId: 1,
      promptVariables: {}, outputSchema: z.string(), idempotencyKey: `k-${Math.random()}`,
    });
    expect(traces[0]).toMatchObject({ engine: 'legacy', triggerCode: null, task: null, masterPromptCode: null });
  });

  it('métadonnées : seules les valeurs connues sont écrites', () => {
    const base = {
      traceId: 't', useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'x', accountId: 1, provider: 'p', model: 'm',
      promptVersion: 'v', usedFallback: false, inputTokens: 0, outputTokens: 0, costMicros: 0, durationMs: 0,
      status: 'success', billable: true, shadow: false,
    } as const;
    expect(configMetadata(base)).toEqual({});
    expect(configMetadata({ ...base, reasoning: null, maxOutputTokens: 500, engine: 'new', triggerCode: 'schedule_daily' }))
      .toEqual({ reasoning: null, maxOutputTokens: 500, engine: 'new', trigger: 'schedule_daily' });
  });
});
