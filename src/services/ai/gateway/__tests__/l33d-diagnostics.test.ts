/**
 * Lot 33D — ticket « enrichir les rapports d'échec et rendre INVALID_OUTPUT
 * diagnosticable ». Tests DIAG-xx (critères d'acceptation, cas 1 à 7, §1 à §15).
 *
 *  · DIAG-01 (cas 1) JSON invalide → INVALID_OUTPUT / MALFORMED_JSON, étape json_parse, sortie consultable ;
 *  · DIAG-02 (cas 2) mauvais type → INVALID_TYPE, chemin, attendu `string | null`, reçu `object` ;
 *  · DIAG-03 (cas 3) enum incorrect → INVALID_ENUM, valeur reçue, valeurs attendues, chemin ;
 *  · DIAG-04 (cas 4) sortie tronquée → OUTPUT_TRUNCATED, finish_reason MAX_TOKENS ;
 *  · DIAG-05 (cas 5) trois fallbacks identiques → détail par appel + même signature ;
 *  · DIAG-06 (cas 6) timeout → TIMEOUT, étape provider_generation, aucune sortie ;
 *  · DIAG-07 (cas 7) job DONE mais analyse en échec → Job : DONE, Résultat métier : FAILED ;
 *  · DIAG-08 à DIAG-20 : familles fournisseur, champ obligatoire, réponse vide,
 *    chaîne de contrôles, contrat de sortie, métadonnées natives, compteurs,
 *    diagnostic final factuel, export, accès restreint, assistant, cause
 *    initiale jamais masquée, UNKNOWN complet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

const capture = vi.hoisted(() => ({
  diags: [] as Array<Record<string, any>>, traces: [] as Array<Record<string, any>>,
  latest: null as unknown, audit: [] as Array<Record<string, unknown>>, admin: true,
  outputs: [] as unknown[], usageTrace: 'trace-1' as string | null, detail: null as unknown,
}));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async (r: Record<string, unknown>) => { capture.diags.push(r); }),
  latestFailureForSource: vi.fn(async () => capture.latest),
  readTraceModelOutputs: vi.fn(async () => capture.outputs),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { capture.traces.push(t); return 1000 + capture.traces.length; }),
}));
vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => (capture.usageTrace ? [{ trace_id: capture.usageTrace }] : [])) },
  db: {},
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: vi.fn(async (e: Record<string, unknown>) => { capture.audit.push(e); }) }));
vi.mock('@/app/api/admin/ai/config-versions/_shared', () => ({
  requireAdminContext: vi.fn(async () => (capture.admin
    ? { ok: true, ctx: { adminUserId: 7 } }
    : { ok: false, response: NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 }) })),
  toErrorResponse: () => NextResponse.json({ error: 'INTERNAL' }, { status: 500 }),
}));
vi.mock('@/services/ai/telemetry/execution-log.repository', () => ({ getExecutionDetail: vi.fn(async () => capture.detail) }));

const { AiGateway } = await import('../ai-gateway');
const { AiGatewayError } = await import('../errors');
const { FakeProvider, setAiProvider } = await import('../providers');
const { validateOutput } = await import('../output-validator');
const { classifyCallError, cascadeDiagnosis, finalDiagnosis, isTruncated, failureSignature } = await import('../diagnostics/classify');
const { displayCause, AI_FAILURE_FAMILIES, INVALID_OUTPUT_SUBTYPES, AI_FAILURE_STAGES } = await import('../diagnostics/taxonomy');
const { responseMeta, responseText } = await import('../providers/gemini.provider');
const { buildGenerationConfig } = await import('../providers/gemini-generation-config');
const { buildExecutionDiagnosis } = await import('../../telemetry/execution-diagnosis');
const { buildExecutionExport } = await import('../../telemetry/execution-export');
const { isModelOutputAccessAllowed } = await import('../../telemetry/model-output-access');
const { t1FailedBusinessResult } = await import('../../source-analysis/queue/t1-handler');
const { BUSINESS_RESULTS, isBusinessResult } = await import('../../queue/queue-policy');
const { T1_TEST_OPERATION, t1TestVariables } = await import('./t1-master-request');
const { asTestContract } = await import('../output-resolution/runtime-contract');
const modelOutputRoute = await import('@/app/api/admin/ai/executions/[id]/model-output/route');
const exportRoute = await import('@/app/api/admin/ai/executions/[id]/export/route');

const Schema = asTestContract(z.object({
  task: z.literal('GROUP_UPLOAD'),
  title: z.string(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  type: z.enum(['INVOICE', 'RECEIPT', 'CONTRACT', 'OTHER']),
}));
let fake: InstanceType<typeof FakeProvider>;
const requete = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 1, sourceIds: [167],
  promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `l33d-diag-${Math.random()}`, ...over,
});
const out = (o: Record<string, unknown>) => JSON.stringify({ task: 'GROUP_UPLOAD', title: 'Facture', purchaseDate: '2026-04-24', type: 'INVOICE', ...o });
const err = (fn: () => unknown): any => { try { fn(); } catch (e) { return e; } throw new Error('aucune erreur'); };

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  capture.diags.length = 0; capture.traces.length = 0; capture.audit.length = 0;
  capture.latest = null; capture.admin = true; capture.outputs = []; capture.usageTrace = 'trace-1';
  process.env.AI_OUTPUT_REPAIR_PASS = 'off';
  delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS;
});

describe('DIAG-01 (cas 1) — JSON invalide', () => {
  it('INVALID_OUTPUT / MALFORMED_JSON, étape json_parse, erreur et sortie reçue consultables', async () => {
    fake.onAny(() => ({ rawText: '{"title":"Facture",', inputTokens: 100, outputTokens: 7, meta: { finishReason: 'STOP' } }));
    await expect(AiGateway.execute(requete())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' });
    const d = capture.diags[0];
    expect(d.diagnostic).toMatchObject({ outcome: 'FAILED', family: 'INVALID_OUTPUT', subtype: 'MALFORMED_JSON', stage: 'json_parse', outputReceived: true });
    expect(d.diagnostic.error.message).toMatch(/Structure JSON incomplète/);
    expect(d.output.raw).toBe('{"title":"Facture",');
    expect(displayCause(d.diagnostic.family, d.diagnostic.subtype)).toBe('INVALID_OUTPUT / MALFORMED_JSON');
    expect(d.diagnostic.controls).toMatchObject({ providerResponse: 'passed', json: 'failed', schema: 'not_run', businessValidation: 'not_run', persistence: 'not_run' });
  });
});

describe('DIAG-02 (cas 2) — mauvais type', () => {
  it('INVALID_TYPE · $.purchaseDate · attendu string | null · reçu object · valeur reçue', () => {
    const e = err(() => validateOutput(out({ purchaseDate: { day: 24 } }), Schema, 'op', 'json', { allowPruning: false }));
    expect(e.code).toBe('INVALID_OUTPUT');
    const i = e.detail.issues[0];
    expect(e.detail.subtype).toBe('INVALID_TYPE');
    expect(i).toMatchObject({ subtype: 'INVALID_TYPE', path: '$.purchaseDate', expected: 'string | null', received: 'object' });
    expect(i.receivedValue).toContain('"day": 24');
    expect(i.message).toMatch(/expected string/);
    expect(e.detail.stage).toBe('schema_validation');
  });
});

describe('DIAG-03 (cas 3) — enum incorrect', () => {
  it('INVALID_ENUM, valeur reçue, valeurs attendues, chemin', () => {
    const e = err(() => validateOutput(out({ type: 'BANANE' }), Schema, 'op', 'json', { allowPruning: false }));
    expect(e.detail.issues[0]).toMatchObject({
      subtype: 'INVALID_ENUM', path: '$.type', receivedValue: '"BANANE"', allowedValues: ['INVOICE', 'RECEIPT', 'CONTRACT', 'OTHER'],
    });
  });
});

describe('DIAG-04 (cas 4) — sortie tronquée', () => {
  it('OUTPUT_TRUNCATED et finish_reason = MAX_TOKENS, jamais un simple INVALID_OUTPUT', async () => {
    fake.onAny(() => ({ rawText: '{"task":"GROUP_UPLOAD","title":"Fact', inputTokens: 10, outputTokens: 32_768, meta: { finishReason: 'MAX_TOKENS' } }));
    await expect(AiGateway.execute(requete({ maxModelAttempts: 1 }))).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    const d = capture.diags[0].diagnostic;
    expect(d).toMatchObject({ family: 'INVALID_OUTPUT', subtype: 'OUTPUT_TRUNCATED', stage: 'response_reception' });
    expect(d.provider).toMatchObject({ finishReason: 'MAX_TOKENS', maxTokensReached: true, tokenUsage: { output: 32_768 } });
    expect(capture.traces[0].failure).toMatchObject({ subtype: 'OUTPUT_TRUNCATED' });
  });
  it('détection : fin déclarée par le fournisseur, sinon plafond atteint', () => {
    expect(isTruncated({ finishReason: 'MAX_TOKENS' })).toBe(true);
    expect(isTruncated({ stopReason: 'max_tokens' })).toBe(true);
    expect(isTruncated({ finishReason: 'STOP', tokenUsage: { input: 1, output: 100 }, configuredMaxOutputTokens: 100 })).toBe(false);
    expect(isTruncated({ tokenUsage: { input: 1, output: 90, thoughts: 10 }, configuredMaxOutputTokens: 100 })).toBe(true);
  });
});

describe('DIAG-05 (cas 5) — trois fallbacks identiques', () => {
  it('détail de chaque appel, même signature, diagnostic de cascade et final factuels', async () => {
    fake.onAny(() => ({ rawText: out({ purchaseDate: { day: 24 } }), inputTokens: 13_927, outputTokens: 1790, meta: { finishReason: 'STOP' } }));
    await expect(AiGateway.execute(requete())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    const analyses = capture.diags.map((d) => d.diagnostic);
    expect(analyses).toHaveLength(3);
    expect(capture.diags.map((d) => d.modelRank)).toEqual(['primary', 'fallback_1', 'fallback_2']);
    expect(new Set(analyses.map((d) => d.signature)).size).toBe(1);
    const casc = cascadeDiagnosis(analyses);
    expect(casc).toMatchObject({ identical: true, failedCalls: 3, cause: 'INVALID_OUTPUT / INVALID_TYPE', path: '$.purchaseDate', expected: 'string | null', received: 'object' });
    const lignes = finalDiagnosis({ treatment: 'T1', succeeded: false, calls: analyses });
    expect(lignes[0]).toBe('Échec T1.');
    expect(lignes.join('\n')).toMatch(/Les 3 modèles ont retourné une sortie/);
    expect(lignes.join('\n')).toMatch(/pendant la validation du schéma avec la même signature/);
    expect(lignes.join('\n')).toMatch(/Cause commune : \$\.purchaseDate/);
    expect(lignes.join('\n')).toMatch(/Aucune modification métier/);
  });
});

describe('DIAG-06 (cas 6) — timeout', () => {
  it('TIMEOUT, étape provider_generation, aucune sortie présentée comme existante', async () => {
    fake.onAny(() => { throw new AiGatewayError('TIMEOUT', 'n/a', 'Délai dépassé (120000 ms) sur gemini-2.5-pro', { recoverable: true }); });
    await expect(AiGateway.execute(requete({ maxModelAttempts: 1 }))).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'TIMEOUT' });
    const d = capture.diags[0];
    expect(d.diagnostic).toMatchObject({ family: 'TIMEOUT', subtype: null, stage: 'provider_generation', outputReceived: false });
    expect(d.output).toBeNull();
    expect(d.diagnostic.controls.providerResponse).toBe('failed');
    expect(capture.traces[0]).toMatchObject({ status: 'error', inputTokens: 0, outputTokens: 0 });
  });
});

describe('DIAG-07 (cas 7) — job terminé mais analyse en échec', () => {
  it('Job : DONE · Résultat métier : FAILED (jamais lisible comme une réussite)', async () => {
    expect(BUSINESS_RESULTS).toContain('FAILED');
    capture.latest = { traceId: 't', family: 'INVALID_OUTPUT', subtype: 'SCHEMA_VALIDATION_FAILED', stage: 'schema_validation', signature: 'abc', createdAt: '' };
    const r = await t1FailedBusinessResult(167);
    expect(isBusinessResult(r)).toBe(true);
    expect(r).toEqual({ result: 'FAILED', detail: { fileId: 167, cause: 'INVALID_OUTPUT / SCHEMA_VALIDATION_FAILED', stage: 'schema_validation', signature: 'abc', traceId: 't' } });
    const diag = buildExecutionDiagnosis({
      treatment: 'T1', diagnostics: [],
      calls: [{ id: 1, status: 'error', errorCode: 'INVALID_OUTPUT', modelRank: 'primary', model: 'm', callKind: 'analysis', failure: null } as never],
      job: { status: 'DONE', attempts: 2, businessResult: 'FAILED', businessResultDetail: r.detail ?? null },
    });
    expect(diag.result).toEqual({ jobStatus: 'DONE', businessResult: 'FAILED', cause: 'INVALID_OUTPUT / SCHEMA_VALIDATION_FAILED', doneButFailed: true });
  });
});

describe('DIAG-08 — familles d’erreur fournisseur (§1, §14)', () => {
  const c = (e: unknown) => classifyCallError(e);
  it('cause réellement remontée, étape exacte', () => {
    expect(c(Object.assign(new Error('Resource has been exhausted'), { status: 429 }))).toMatchObject({ family: 'RATE_LIMIT', stage: 'provider_request', httpStatus: 429 });
    expect(c(Object.assign(new Error('API key not valid'), { status: 400 }))).toMatchObject({ family: 'AUTH_ERROR' });
    expect(c(Object.assign(new Error('forbidden'), { status: 403 }))).toMatchObject({ family: 'AUTH_ERROR' });
    expect(c(Object.assign(new Error('The input token count (1200000) exceeds the maximum number of tokens allowed'), { status: 400 }))).toMatchObject({ family: 'CONTEXT_TOO_LARGE' });
    expect(c(Object.assign(new Error('Invalid argument: bad mime type'), { status: 400 }))).toMatchObject({ family: 'INPUT_ERROR', stage: 'provider_request' });
    expect(c(Object.assign(new Error('response_schema: too many states'), { status: 400 }))).toMatchObject({ family: 'INVALID_OUTPUT', subtype: 'STRUCTURED_OUTPUT_REJECTED', stage: 'structured_output' });
    expect(c(Object.assign(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'), {}))).toMatchObject({ family: 'PROVIDER_ERROR', httpStatus: 503, providerErrorCode: 'UNAVAILABLE' });
    expect(c(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toMatchObject({ family: 'NETWORK_ERROR' });
    expect(c(Object.assign(new Error('[GoogleGenAI Error]: Candidate was blocked due to SAFETY'), { blocked: true }))).toMatchObject({ family: 'SAFETY_BLOCK', stage: 'provider_generation' });
    expect(c(Object.assign(new Error('S3 indisponible'), { aiStage: 'request_build' }))).toMatchObject({ family: 'INTERNAL_ERROR', stage: 'request_build' });
    expect(c(new AiGatewayError('TIMEOUT', 'x', 'Délai dépassé'))).toMatchObject({ family: 'TIMEOUT', stage: 'provider_generation' });
  });
  it('DIAG-20 — UNKNOWN seulement si non classable, avec étape, exception, message et pile', () => {
    const u = c(new RangeError('quelque chose d’inattendu'));
    expect(u.family).toBe('UNKNOWN');
    expect(u.stage).toBe('provider_request');
    expect(u.error).toMatchObject({ exception: 'RangeError', message: 'quelque chose d’inattendu' });
    expect(u.error.stack).toMatch(/RangeError/);
  });
  it('taxonomie complète du ticket', () => {
    expect(AI_FAILURE_FAMILIES).toEqual(expect.arrayContaining(['INVALID_OUTPUT', 'TIMEOUT', 'PROVIDER_ERROR', 'RATE_LIMIT', 'AUTH_ERROR', 'CONTEXT_TOO_LARGE', 'INPUT_ERROR', 'SAFETY_BLOCK', 'NETWORK_ERROR', 'INTERNAL_ERROR']));
    expect(INVALID_OUTPUT_SUBTYPES).toEqual(['EMPTY_RESPONSE', 'MALFORMED_JSON', 'SCHEMA_VALIDATION_FAILED', 'MISSING_REQUIRED_FIELD', 'INVALID_ENUM', 'INVALID_TYPE', 'OUTPUT_TRUNCATED', 'STRUCTURED_OUTPUT_REJECTED', 'PARSER_ERROR', 'BUSINESS_VALIDATION_FAILED', 'RUNTIME_CONTRACT_MISMATCH', 'UNKNOWN']);
    expect(AI_FAILURE_STAGES).toEqual(['request_build', 'provider_request', 'provider_generation', 'response_reception', 'structured_output', 'json_parse', 'schema_validation', 'business_validation', 'result_mapping', 'persistence', 'post_processing']);
  });
});

describe('DIAG-09 / DIAG-10 — champ obligatoire absent, réponse vide, parseur', () => {
  it('MISSING_REQUIRED_FIELD : chemin et nom du champ', () => {
    const S = z.object({ document: z.object({ assetCandidate: z.string() }) });
    const e = err(() => validateOutput('{"document":{}}', S, 'op'));
    expect(e.detail.issues[0]).toMatchObject({ subtype: 'MISSING_REQUIRED_FIELD', path: '$.document.assetCandidate', missingField: 'assetCandidate' });
  });
  it('EMPTY_RESPONSE à la réception', () => {
    const e = err(() => validateOutput('   ', Schema, 'op'));
    expect(e.detail).toMatchObject({ subtype: 'EMPTY_RESPONSE', stage: 'response_reception' });
  });
  it('PARSER_ERROR : exception du parseur interne (jamais classée panne fournisseur)', () => {
    const S = z.preprocess(() => { throw new Error('parseur cassé'); }, z.object({}));
    const e = err(() => validateOutput('{}', S, 'op'));
    expect(e.code).toBe('INVALID_OUTPUT');
    expect(e.detail).toMatchObject({ subtype: 'PARSER_ERROR', stage: 'result_mapping' });
  });
  it('BUSINESS_VALIDATION_FAILED : règle métier déclarée par le contrat', () => {
    const S = z.object({ a: z.number() }).superRefine((v, ctx) => {
      if (v.a < 0) ctx.addIssue({ code: 'custom', message: 'montant négatif', path: ['a'], params: { kind: 'business', expected: 'montant ≥ 0' } });
    });
    const e = err(() => validateOutput('{"a":-1}', S, 'op'));
    expect(e.detail).toMatchObject({ subtype: 'BUSINESS_VALIDATION_FAILED', stage: 'business_validation' });
  });
});

describe('DIAG-11 / DIAG-12 / DIAG-13 — chaîne de contrôles, contrat de sortie, métadonnées natives', () => {
  it('schéma invalide : fournisseur ✓, structured output ✓, JSON ✓, schéma ✗, métier et persistance non exécutés', async () => {
    fake.onAny(() => ({ rawText: out({ type: 'BANANE' }), inputTokens: 5, outputTokens: 5, meta: { finishReason: 'STOP', providerRequestId: 'resp-42', modelVersion: 'gemini-x-001', thoughtsTokens: 12 } }));
    await expect(AiGateway.execute(requete({ maxModelAttempts: 1 }))).rejects.toBeDefined();
    const d = capture.diags[0].diagnostic;
    expect(d.controls).toEqual({ providerResponse: 'passed', structuredOutput: 'passed', json: 'passed', schema: 'failed', businessValidation: 'not_run', persistence: 'not_run' });
    expect(d.schema).toMatchObject({ name: 'T1GroupUploadOutput', version: 't1_group_upload@v1', hash: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(d.provider).toMatchObject({ provider: 'fake', model: expect.any(String), providerRequestId: 'resp-42', modelVersion: 'gemini-x-001', finishReason: 'STOP', tokenUsage: { input: 5, output: 5, thoughts: 12 } });
    expect(capture.traces[0].providerMeta).toMatchObject({ finishReason: 'STOP', providerRequestId: 'resp-42' });
    expect(capture.diags[0].sourceIds).toEqual([167]);
  });
  it('adaptateur Gemini : fin de génération, identifiant, raison de sécurité, jetons de raisonnement', () => {
    const m = responseMeta({
      responseId: 'r1', modelVersion: 'gemini-2.5-pro-001',
      candidates: [{ finishReason: 'MAX_TOKENS' as never, finishMessage: 'limite', content: { parts: [{ text: '{' }] } }],
      usageMetadata: { thoughtsTokenCount: 900, totalTokenCount: 2000 },
    } as never);
    expect(m).toEqual({ providerRequestId: 'r1', modelVersion: 'gemini-2.5-pro-001', finishReason: 'MAX_TOKENS', finishMessage: 'limite', safetyReason: null, thoughtsTokens: 900, totalTokens: 2000 });
    expect(() => responseText({ candidates: [{ finishReason: 'SAFETY' as never }] } as never)).toThrow(/SAFETY/);
    expect(buildGenerationConfig({ model: 'gemini-2.5-pro', responseSchema: { type: 'object' } })).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } });
  });
});

describe('DIAG-14 / DIAG-15 — compteurs explicites et diagnostic final factuel', () => {
  const appel = (id: number, rank: string, status: string, kind: 'analysis' | 'repair' = 'analysis') =>
    ({ id, modelRank: rank, model: `m${id}`, status, errorCode: status === 'error' ? 'INVALID_OUTPUT' : null, callKind: kind, failure: null, inputTokens: 1, outputTokens: 1 }) as never;
  it('Tentatives du job : 2 · Appels modèle : 3 · Fallbacks modèle : 2 (réparations comptées à part)', () => {
    const d = buildExecutionDiagnosis({
      treatment: 'T1', diagnostics: [],
      calls: [appel(1, 'primary', 'error'), appel(2, 'primary', 'error', 'repair'), appel(3, 'fallback_1', 'error'), appel(4, 'fallback_2', 'success')],
      job: { status: 'DONE', attempts: 2 },
    });
    expect(d.counters).toEqual({ jobAttempts: 2, modelCalls: 3, modelFallbacks: 2, repairCalls: 1 });
    expect(d.calls.map((c) => c.label)).toEqual(['principal', 'réparation (principal)', 'fallback 1', 'fallback 2']);
    expect(d.result.businessResult).toBe('SUCCEEDED');
    expect(d.finalDiagnosis[0]).toBe('Réussite T1.');
  });
  it('réussite après correction : la règle est nommée, aucune hypothèse', () => {
    const l = finalDiagnosis({ treatment: 'T1', succeeded: true, calls: [{ outcome: 'REPAIRED', callKind: 'analysis', family: 'INVALID_OUTPUT', subtype: 'INVALID_TYPE', stage: 'schema_validation', issues: [], signature: 's', outputReceived: true, repairs: [{ stage: 'normalization', rule: 'date_object_to_iso', path: '$.x' }] }] });
    expect(l).toEqual(['Réussite T1.', 'Sortie acceptée après correction automatique (date_object_to_iso).']);
  });
  it('signature : chemin générique (indices ignorés)', () => {
    const base = { family: 'INVALID_OUTPUT' as const, subtype: 'INVALID_TYPE' as const, stage: 'schema_validation' as const };
    const i = (p: string) => [{ subtype: 'INVALID_TYPE' as const, path: p, expected: 'string', received: 'object', receivedValue: null, message: '' }];
    expect(failureSignature({ ...base, issues: i('$.facts[1].x') })).toBe(failureSignature({ ...base, issues: i('$.facts[7].x') }));
    expect(failureSignature({ ...base, issues: i('$.a') })).not.toBe(failureSignature({ ...base, issues: i('$.b') }));
  });
});

describe('DIAG-16 / DIAG-17 — sortie modèle : admin uniquement, accès journalisé, export enrichi', () => {
  it('la sortie brute est conservée pour un appel en échec (masquée à l’écriture)', async () => {
    fake.onAny(() => ({ rawText: out({ type: 'BANANE' }), inputTokens: 5, outputTokens: 5 }));
    await expect(AiGateway.execute(requete({ maxModelAttempts: 1 }))).rejects.toBeDefined();
    expect(capture.diags[0].output.raw).toContain('BANANE');
  });
  it('route dédiée : garde admin, liste restreinte optionnelle, chaque accès journalisé', async () => {
    const post = (id: string) => modelOutputRoute.POST(new NextRequest(`http://x/api/admin/ai/executions/${id}/model-output`, { method: 'POST' }), { params: Promise.resolve({ id }) });
    capture.outputs = [{ diagnosticId: 1, model: 'm', callIndex: 0, raw: '{"a":1}', extracted: null, parsed: null }];
    const ok = await post('2644');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect((await ok.json()).outputs).toHaveLength(1);
    expect(capture.audit[0]).toMatchObject({ action: 'AI_MODEL_OUTPUT_READ', targetType: 'AI_EXECUTION', targetId: 2644, result: 'SUCCESS' });

    process.env.AI_MODEL_OUTPUT_ADMIN_IDS = '1,2';
    expect((await post('2644')).status).toBe(403);
    expect(capture.audit[1]).toMatchObject({ result: 'DENIED' });
    expect(isModelOutputAccessAllowed(2, '1,2')).toBe(true);
    expect(isModelOutputAccessAllowed(9, '')).toBe(true);

    capture.admin = false;
    expect((await post('2644')).status).toBe(403);
    expect((await post('abc')).status).toBe(403);
  });
  it('export : diagnostic inclus, sortie modèle seulement sur demande explicite (journalisée)', async () => {
    const appel = { id: 2644, createdAt: new Date(), useCaseCode: 'SOURCE_ANALYSIS', treatment: 'T1', operationCode: 't1_analyze_document', status: 'error', errorCode: 'INVALID_OUTPUT', errorMessage: 'x', modelRank: 'primary', model: 'gemini-2.5-pro', callKind: 'analysis', failure: { family: 'INVALID_OUTPUT', subtype: 'SCHEMA_VALIDATION_FAILED', stage: 'schema_validation', signature: 's' } };
    capture.detail = { call: appel, traceId: 'trace-1', calls: [appel], steps: [], job: null, inputs: [], modifications: [], t2: null };
    const x = buildExecutionExport(capture.detail as never);
    expect(x.diagnosis.calls[0]).toMatchObject({ cause: 'INVALID_OUTPUT / SCHEMA_VALIDATION_FAILED', stage: 'schema_validation' });
    expect(x.modelOutputs).toBeUndefined();
    const get = (q: string) => exportRoute.GET(new NextRequest(`http://x/api/admin/ai/executions/2644/export${q}`), { params: Promise.resolve({ id: '2644' }) });
    expect((await (await get('')).json()).modelOutputs).toBeUndefined();
    capture.outputs = [{ diagnosticId: 1, model: 'm', callIndex: 0, raw: 'IBAN FR76 3000 6000 0112 3456 7890 189', extracted: null, parsed: null }];
    const body = await (await get('?includeModelOutput=1')).json();
    expect(body.modelOutputs[0].raw).toContain('[IBAN_MASQUE]');
    expect(capture.audit.at(-1)).toMatchObject({ action: 'AI_MODEL_OUTPUT_READ', details: { purpose: 'export', outputs: 1 } });
  });
});

describe('DIAG-18 / DIAG-19 — assistant sans sortie brute ; cause initiale jamais masquée', () => {
  it('chaque appel de la cascade a son rapport ; le message final cite chaque modèle', async () => {
    let n = 0;
    fake.onAny(() => {
      n++;
      if (n === 1) throw Object.assign(new Error('Resource has been exhausted'), { status: 429 });
      return { rawText: out({ type: 'BANANE' }), inputTokens: 5, outputTokens: 5 };
    });
    const e = await AiGateway.execute(requete()).catch((x) => x);
    expect(e.code).toBe('ALL_MODELS_FAILED');
    expect(capture.diags.map((d) => d.diagnostic.family)).toEqual(['RATE_LIMIT', 'INVALID_OUTPUT', 'INVALID_OUTPUT']);
    expect(e.message.split(' — ')).toHaveLength(3);
    // Le repli après un 429 n'est pas « informé » (aucune sortie invalide avant lui).
    expect(capture.diags[1].diagnostic.informedOfPreviousError).toBe(false);
    expect(capture.diags[2].diagnostic.informedOfPreviousError).toBe(true);
  });
});

describe('DIAG-18 — assistant (T2) : diagnostic sans sortie brute (CDC Assistant §29.6)', () => {
  it('appel invalide : diagnostic complet, aucune sortie conservée, message sans extrait', async () => {
    const { t2MasterVariables } = await import('../../assistant/master/t2-answer');
    fake.onAny(() => ({ rawText: 'pas du json IBAN FR76 3000 6000 0112 3456 7890 189', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute({
      useCaseCode: 'INTELLIGENT_ASSISTANT' as never, operationCode: 't2_answer', accountId: 1,
      promptVariables: t2MasterVariables('ANSWER', { QUESTION: 'q' }),
      outputSchema: asTestContract(z.object({ mode: z.literal('ANSWER'), ok: z.boolean() })), idempotencyKey: `k-${Math.random()}`, maxModelAttempts: 1,
    }).catch(() => null);
    expect(capture.diags[0].diagnostic).toMatchObject({ family: 'INVALID_OUTPUT', subtype: 'MALFORMED_JSON' });
    expect(capture.diags[0].output).toBeNull();
    expect(JSON.stringify(capture.diags[0].diagnostic)).not.toMatch(/IBAN FR76|3000 6000/);
    expect(String(capture.traces[0].errorMessage)).toMatch(/\[extrait non conservé\]/);
  });
});
