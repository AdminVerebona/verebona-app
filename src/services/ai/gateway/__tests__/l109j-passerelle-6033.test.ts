/**
 * Lot 109J — passerelle RÉELLE, fournisseur simulé (cas T3:6033) :
 *   · sortie tronquée : cause exacte portée par l'erreur, secours refusés
 *     comptés comme REFUS (aucune requête), jamais comme générations ;
 *   · schéma non conforme au contrat Gemini : jamais envoyé (aucun 400 payé),
 *     motif `provider_contract` et écarts dans la trace de la requête ;
 *   · délai dépassé : cause TIMEOUT, secours essayé, décomptes exacts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push(t); return h.traces.length; }),
}));
vi.mock('../../queue/circuit-breaker.repository', async (orig) => ({
  ...(await orig<typeof import('../../queue/circuit-breaker.repository')>()),
  noteGatewayOutcome: vi.fn(() => undefined),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setFallbackContextForTests } = await import('../fallback-context');
const { gatewayFailureFacts } = await import('../errors');
const { clearSchemaRejections } = await import('../output-resolution/provider-schema');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

const Schema = t1Schema({ ok: z.boolean() });
let fake: InstanceType<typeof FakeProvider>;
const tronquee = () => ({ rawText: '{"task":"GROUP_UPLOAD","ok":', inputTokens: 48_312, outputTokens: 324, meta: { finishReason: 'MAX_TOKENS', thoughtsTokens: 7_868 } });

function chaine(models: [string, string | null, string | null], over: Record<string, unknown> = {}) {
  __setConfigForTests({ versionId: 1, entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: models[0], fallback1: models[1], fallback2: models[2], maxOutputTokens: 8192, ...over }] });
}
const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7,
  sourceIds: [42], promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `l109j-${Math.random()}`, ...over,
});

beforeEach(() => {
  h.traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  clearSchemaRejections();
});
afterEach(() => {
  __setConfigForTests(null);
  __setFallbackContextForTests(null);
});

describe('L109J-GW — décomptes et causes exacts (cas 6033)', () => {
  it('L109J-GW-01 — sortie tronquée, secours au même plafond : cause OUTPUT_TRUNCATED, 1 modèle sollicité, 2 refus sans requête', async () => {
    chaine(['m-a', 'm-b', 'm-c']);
    fake.on('m-a', tronquee);
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'ALL_MODELS_FAILED' });
    const f = gatewayFailureFacts(e);
    expect(f.cause).toBe('OUTPUT_TRUNCATED');
    expect(f.stats).toEqual({ modelsConsidered: 3, modelsCalled: 1, networkRequests: fake.calls.length, fallbackRefused: 2 });
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a']);
    // Raisonnement tracé à part de la sortie visible.
    const t = h.traces.find((x) => x.model === 'm-a') as { outputTokens: number; providerMeta?: { thoughtsTokens?: number; finishReason?: string } };
    expect(t).toMatchObject({ outputTokens: 324, providerMeta: { thoughtsTokens: 7_868, finishReason: 'MAX_TOKENS' } });
    // Les rangs refusés sont tracés comme NON SOLLICITÉS (jamais une génération échouée).
    expect(h.traces.filter((x) => x.errorCode === 'FALLBACK_NOT_ADMISSIBLE').map((x) => x.model)).toEqual(['m-b', 'm-c']);
  });

  it('L109J-GW-02 — délai dépassé : cause TIMEOUT, secours sollicité, décomptes exacts', async () => {
    chaine(['m-a', 'm-b', null]);
    __setFallbackContextForTests({ coupleQualifications: async () => ({ origin: 'manual', byModel: new Map([['m-b', 'ADMISSIBLE' as const]]) }) });
    fake.on('m-a', () => { throw Object.assign(new Error('Délai dépassé'), { code: 'TIMEOUT' }); })
      .on('m-b', () => { throw Object.assign(new Error('Délai dépassé'), { code: 'TIMEOUT' }); });
    const e = await AiGateway.execute(req()).catch((x) => x);
    const f = gatewayFailureFacts(e);
    expect(f.stats).toMatchObject({ modelsCalled: 2, networkRequests: 2, fallbackRefused: 0 });
    expect(f.cause).toBe('TIMEOUT');
  });

  it('L109J-GW-03 — schéma non conforme au contrat Gemini : non envoyé, motif provider_contract et écarts tracés, réponse validée', async () => {
    chaine(['m-a', null, null]);
    const lourd = t1Schema({ ok: z.boolean(), l: z.array(z.object({ m: z.array(z.object({ n: z.array(z.string()).max(15) })).max(15) })).max(15).optional() });
    fake.on('m-a', () => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    const r = await AiGateway.execute(req({ outputSchema: lourd }));
    expect(r.model).toBe('m-a');
    expect(fake.calls[0].responseSchema).toBeUndefined();
    expect(fake.calls[0].jsonResponse).toBe(true);
    const t = h.traces[0] as { providerRequest?: { schemaOmittedReason: string | null; schemaIssues?: string[] } };
    expect(t.providerRequest?.schemaOmittedReason).toBe('provider_contract');
    expect(t.providerRequest?.schemaIssues?.some((x) => x.startsWith('NESTED_ARRAY_BOUNDS@'))).toBe(true);
  });

  it('L109J-GW-04 — 400 INVALID_ARGUMENT générique sur le schéma : essai diagnostique du MÊME modèle sans schéma, tracé (tentative initiale + retry)', async () => {
    chaine(['m-a', null, null]);
    let n = 0;
    fake.on('m-a', (i) => {
      n++;
      if (i.responseSchema) throw Object.assign(new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'), { status: 400 });
      return { rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 };
    });
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-a');
    expect(n).toBe(2);
    const t = h.traces[0] as { providerAttempts?: Array<{ kind: string; httpStatus: number | null; providerErrorCode: string | null; responseSchemaSent: boolean }> };
    expect(t.providerAttempts?.map((a) => [a.kind, a.responseSchemaSent, a.httpStatus])).toEqual([['initial', true, 400], ['diagnostic_retry', false, null]]);
  });
});
