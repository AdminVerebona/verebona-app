/**
 * Lot 61 — T1-GEM-04 / T1-GEM-05 : une erreur LOCALE déterministe de
 * construction de requête (étape `request_build`) n'est plus classée
 * `PROVIDER_UNAVAILABLE` et ne déclenche AUCUN repli (incident fileId=98 :
 * 3 appels 3738-3740 sur la même erreur ByteString). Les vraies erreurs
 * récupérables (503, réseau, délai) gardent leurs replis.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', () => ({
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { AiGateway, gatewayCodeOf } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { primePricingCache, clearPricingCache } = await import('../pricing/pricing.repository');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { classifyCallError } = await import('../diagnostics/classify');
const { isDeterministicLocalError, isInternalAiErrorCode } = await import('../errors');
const { AttachmentRequestBuildError } = await import('../providers/gemini-files');
const { isDefinitiveGatewayFailure, userFacingFailReason } = await import('../../source-analysis/failure-policy');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

const Schema = t1Schema({ ok: z.boolean() });
const OK = t1Out({ ok: true });
let fake: InstanceType<typeof FakeProvider>;

const PRIX = (model: string) => ({
  provider: 'gemini', model, inputMicros: 0.1, outputMicros: 0.4, currency: 'USD',
  source: 'manual' as const, verified: true, fetchedAt: new Date(),
});
const chaine = () => ({ ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: 'm-b', fallback2: 'm-c' });
const req = () => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 1,
  promptVariables: t1TestVariables(), outputSchema: Schema, idempotencyKey: `k-${Math.random()}`,
});

/** Erreur exacte de la préproduction (undici), posée à l'étape request_build par l'adaptateur. */
const byteString = () => Object.assign(
  new TypeError('Cannot convert argument to a ByteString because the character at index 46 has a value of 768 which is greater than 255.'),
  { aiStage: 'request_build' },
);

beforeEach(() => {
  traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  clearPricingCache();
  primePricingCache([PRIX('m-a'), PRIX('m-b'), PRIX('m-c')]);
  __setConfigForTests({ versionId: 1, entries: [chaine()] });
});
afterEach(() => __setConfigForTests(null));

describe('T1-GEM-04 — classification des erreurs locales', () => {
  it('T1-GEM-04 : ByteString à request_build → déterministe, INTERNAL_ERROR / request_build, jamais PROVIDER_UNAVAILABLE', () => {
    const e = byteString();
    expect(isDeterministicLocalError(e)).toBe(true);
    expect(isDeterministicLocalError(new AttachmentRequestBuildError('x'))).toBe(true);
    const c = classifyCallError(e);
    expect(c).toMatchObject({ family: 'INTERNAL_ERROR', stage: 'request_build' });
    expect(gatewayCodeOf(e, c)).not.toBe('PROVIDER_UNAVAILABLE');
    expect(gatewayCodeOf(e, c)).toBe('REQUEST_BUILD_FAILED');
  });

  it('T1-GEM-04 : les erreurs récupérables restent non déterministes (réseau, 503, délai Files API)', () => {
    expect(isDeterministicLocalError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(false);
    expect(isDeterministicLocalError(Object.assign(new Error('Upload Files API échoué : HTTP 503'), { aiStage: 'request_build' }))).toBe(false);
    expect(isDeterministicLocalError(Object.assign(new Error("Le fichier Files API n'est pas devenu ACTIVE dans le délai"), { aiStage: 'request_build' }))).toBe(false);
    expect(isDeterministicLocalError(new Error('503'))).toBe(false);
  });

  it('T1-GEM-04 : REQUEST_BUILD_FAILED est interne (message générique utilisateur) et définitif pour T1', () => {
    expect(isInternalAiErrorCode('REQUEST_BUILD_FAILED')).toBe(true);
    expect(isDefinitiveGatewayFailure({ code: 'REQUEST_BUILD_FAILED' })).toBe(true);
    expect(userFacingFailReason({ code: 'REQUEST_BUILD_FAILED' })).toMatch(/erreur technique interne/);
  });
});

describe('T1-GEM-05 — aucun repli pour une erreur locale déterministe', () => {
  it('T1-GEM-05 : un seul appel, REQUEST_BUILD_FAILED non récupérable, trace INTERNAL_ERROR / request_build', async () => {
    fake.onAny(() => { throw byteString(); });
    const e = await AiGateway.execute(req()).then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ code: 'REQUEST_BUILD_FAILED', recoverable: false });
    expect(fake.calls.map((c) => c.model)).toEqual(['m-a']);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: 'error', errorCode: 'REQUEST_BUILD_FAILED', modelRank: 'primary' });
    expect(traces[0].failure).toMatchObject({ family: 'INTERNAL_ERROR', stage: 'request_build' });
    expect(traces[0].errorMessage).toMatch(/ByteString/);
  });

  it('T1-GEM-05 : les vraies erreurs récupérables gardent le repli (503 puis succès sur fallback_1)', async () => {
    fake.on('m-a', () => { throw Object.assign(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'), { status: 503 }); });
    fake.on('m-b', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-b');
    expect(traces.map((t) => t.errorCode ?? null)).toEqual(['PROVIDER_UNAVAILABLE', null]);
  });
});
