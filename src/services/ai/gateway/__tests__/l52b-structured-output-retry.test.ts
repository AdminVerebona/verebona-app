/**
 * Lot 52B — ticket « IA Gateway : rattraper les INVALID_ARGUMENT génériques
 * sur structured output avant de changer de modèle » (P1).
 *
 * Incident de référence (trace c4b2a66e…) : les trois modèles refusent la
 * requête T1 en HTTP 400 INVALID_ARGUMENT « Request contains an invalid
 * argument. », 0 jeton, structuredOutputStatus = requested_schema. Le refus
 * ne citant pas le schéma, `callWithSchemaFallback` ne rejouait jamais le
 * même modèle sans `responseSchema` : la cascade envoyait le même schéma aux
 * trois modèles.
 *
 * Fournisseur SIMULÉ (FakeProvider), passerelle réelle. AC1 à AC9 du ticket,
 * plus la classification BO (indisponible ≠ refusée ≠ structured output) et
 * l'observabilité de la requête fournisseur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const capture = vi.hoisted(() => ({ diags: [] as Array<Record<string, unknown>>, traces: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async (r: Record<string, unknown>) => { capture.diags.push(r); }),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { capture.traces.push(t); return capture.traces.length; }),
}));

const { AiGateway, gatewayCodeOf } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const rc = await import('../output-resolution/runtime-contract');
const { providerJsonSchema, clearSchemaRejections, schemaRejectedRecently } = await import('../output-resolution/provider-schema');
const { classifyCallError, isGenericInvalidArgument } = await import('../diagnostics/classify');
const { providerFailureCategory, displayErrorCode } = await import('../diagnostics/taxonomy');
const { describeGenerationConfig } = await import('../providers/gemini-generation-config');
const { describeAttachments } = await import('../providers/gemini-files');
const { buildExecutionDiagnosis } = await import('../../telemetry/execution-diagnosis');
const { isDefinitiveGatewayFailure } = await import('../../source-analysis/failure-policy');
const { T1GroupUploadOutput } = await import('../../source-analysis/master/t1-contract');
const { T1_TEST_OPERATION, t1TestVariables } = await import('./t1-master-request');

type Attempt = { step: number; kind: string; responseSchemaSent: boolean; providerSchemaHash: string | null; responseMimeType: string | null; outcome: string; httpStatus: number | null; providerErrorCode: string | null; family: string | null };
type Trace = {
  model: string; status: string; errorCode?: string; callKind?: string;
  providerMeta?: { structuredOutput?: string };
  runtimeContract?: { contractId: string; contractVersion: number; schemaVersion: string; schemaHash: string; compatTableVersion: number; structuredOutput: boolean; providerSchemaHash: string | null };
  providerRequest?: Record<string, unknown>;
  providerAttempts?: Attempt[];
  failure?: { family: string; subtype: string | null; stage: string | null };
};

/** Erreur brute du SDK `@google/genai` pour un 400 générique (forme réelle). */
const invalidArgument = (message = 'Request contains an invalid argument.') => Object.assign(
  new Error(`{"error":{"code":400,"message":"${message}","status":"INVALID_ARGUMENT"}}`),
  { name: 'ClientError', status: 400 },
);
const groupOk = () => JSON.stringify({ task: 'GROUP_UPLOAD', groups: [[0]], reason: 'un seul fichier' });
const requete = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 1,
  promptVariables: t1TestVariables('facture'), outputSchema: T1GroupUploadOutput,
  idempotencyKey: `l52b-${Math.random()}`, ...over,
});
const contrat = () => rc.resolveRuntimeContract({ schemaName: 'T1GroupUploadOutput', operationCode: T1_TEST_OPERATION, callerSchema: T1GroupUploadOutput }).contract;
const psHash = () => rc.providerSchemaHash(providerJsonSchema(contrat().canonical).schema);
const traces = () => capture.traces as Trace[];
const analyses = () => fake.calls.filter((c) => (c.callKind ?? 'analysis') === 'analysis');

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  capture.diags.length = 0;
  capture.traces.length = 0;
  clearSchemaRejections();
  delete process.env.AI_OUTPUT_REPAIR_PASS;
  delete process.env.AI_STRUCTURED_OUTPUT;
});

describe('AC1 — cas réel actuel : 400 « Request contains an invalid argument. » avec responseSchema', () => {
  it('le même modèle est rappelé sans responseSchema', async () => {
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: groupOk(), inputTokens: 10, outputTokens: 5 };
    });
    await AiGateway.execute(requete());
    const [a, b] = analyses();
    expect(a.responseSchema).toBeDefined();
    expect(b.responseSchema).toBeUndefined();
    expect(b.model).toBe(a.model);
  });

  it('classification : INPUT_ERROR / provider_request, sans sous-type — erreur générique', () => {
    const c = classifyCallError(invalidArgument());
    expect(c).toMatchObject({ family: 'INPUT_ERROR', stage: 'provider_request', subtype: null, httpStatus: 400, providerErrorCode: 'INVALID_ARGUMENT' });
    expect(isGenericInvalidArgument(c)).toBe(true);
    // Statut fournisseur seul (sans code HTTP) : générique aussi.
    expect(isGenericInvalidArgument(classifyCallError(new Error('INVALID_ARGUMENT: Request contains an invalid argument.')))).toBe(true);
    // Statut plus précis que INVALID_ARGUMENT : jamais générique.
    expect(isGenericInvalidArgument(classifyCallError(Object.assign(new Error('{"error":{"code":400,"message":"User location is not supported","status":"FAILED_PRECONDITION"}}'), { status: 400 })))).toBe(false);
    expect(isGenericInvalidArgument(classifyCallError(Object.assign(new Error('models/x is not found'), { status: 404 })))).toBe(false);
  });
});

describe('AC2 — retry réussi : avec schéma → 400 générique, sans schéma → succès', () => {
  it('résultat utilisé, aucun fallback modèle, schema_rejected_retried_without, modèle + schemaHash mémorisés', async () => {
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: groupOk(), inputTokens: 10, outputTokens: 5 };
    });
    const res = await AiGateway.execute(requete());
    expect(res.data).toEqual({ task: 'GROUP_UPLOAD', groups: [[0]], reason: 'un seul fichier' });
    expect(res.usedFallback).toBe(false);
    // Deux appels fournisseur, tous deux au modèle principal : STOP cascade.
    expect(analyses()).toHaveLength(2);
    expect(new Set(analyses().map((c) => c.model)).size).toBe(1);
    const model = analyses()[0].model;
    // Une seule ligne d'appel modèle (pas un fallback), statut structured output explicite.
    expect(traces()).toHaveLength(1);
    expect(traces()[0]).toMatchObject({ status: 'success', providerMeta: { structuredOutput: 'schema_rejected_retried_without' } });
    expect(schemaRejectedRecently(model, contrat().schemaHash)).toBe(true);
    // Les appels suivants partent directement sans structured output (TTL existant).
    fake.calls.length = 0;
    await AiGateway.execute(requete());
    expect(analyses()).toHaveLength(1);
    expect(analyses()[0].responseSchema).toBeUndefined();
    expect(traces()[1].providerRequest).toMatchObject({ responseSchemaSent: false, schemaOmittedReason: 'recent_rejection' });
  });

  it('trace des tentatives internes : structurée → HTTP 400 INVALID_ARGUMENT → diagnostique sans schéma → SUCCESS', async () => {
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: groupOk(), inputTokens: 10, outputTokens: 5 };
    });
    await AiGateway.execute(requete());
    const t = traces()[0];
    expect(t.providerAttempts).toEqual([
      expect.objectContaining({ step: 1, kind: 'initial', responseSchemaSent: true, providerSchemaHash: psHash(), responseMimeType: 'application/json', outcome: 'FAILED', httpStatus: 400, providerErrorCode: 'INVALID_ARGUMENT', family: 'INPUT_ERROR' }),
      expect.objectContaining({ step: 2, kind: 'diagnostic_retry', responseSchemaSent: false, providerSchemaHash: null, responseMimeType: 'application/json', outcome: 'SUCCESS' }),
    ]);
    // Requête fournisseur décrite sans contenu (première tentative).
    expect(t.providerRequest).toMatchObject({ responseSchemaSent: true, providerSchemaHash: psHash(), responseMimeType: 'application/json', schemaOmittedReason: null, attachments: { count: 0, items: [] } });
    expect(typeof t.providerRequest!.schemaNodes).toBe('number');
    expect(t.providerRequest!.thinkingConfig).toEqual(expect.any(String));
    // Jamais de prompt, de contenu ni de schéma dans la trace.
    const json = JSON.stringify({ r: t.providerRequest, a: t.providerAttempts });
    expect(json).not.toContain('CONTRAT RUNTIME');
    expect(json).not.toContain('"properties"');
    expect(json).not.toContain('facture');
  });
});

describe('AC3 — retry également en échec (même 400)', () => {
  it('aucune mémorisation, fallback modèle autorisé, aucun troisième appel au même modèle, cause INPUT_ERROR conservée', async () => {
    fake.onAny(() => { throw invalidArgument(); });
    const err = await AiGateway.execute(requete()).catch((e) => e);
    expect(err).toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'PROVIDER_REQUEST_REJECTED' });
    const parModele = new Map<string, Array<boolean>>();
    for (const c of analyses()) parModele.set(c.model, [...(parModele.get(c.model) ?? []), c.responseSchema !== undefined]);
    // Lot 87A (R10, R57) : 400 générique = cause indéterminée → la cascade continue
    // pour UN essai alternatif seulement ; le troisième modèle est refusé (tracé, sans appel).
    expect(parModele.size).toBe(2);
    for (const [model, appels] of parModele) {
      expect(appels).toEqual([true, false]); // exactement 2 appels : avec, puis sans schéma
      expect(schemaRejectedRecently(model, contrat().schemaHash)).toBe(false);
    }
    expect(traces().filter((t) => t.errorCode === 'FALLBACK_NOT_ADMISSIBLE')).toHaveLength(1);
    for (const t of traces().filter((x) => x.errorCode !== 'FALLBACK_NOT_ADMISSIBLE')) {
      expect(t).toMatchObject({ status: 'error', errorCode: 'PROVIDER_REQUEST_REJECTED', failure: { family: 'INPUT_ERROR', subtype: null, stage: 'provider_request' } });
      expect(t.providerMeta?.structuredOutput).toBe('requested_schema');
      expect(t.runtimeContract).toMatchObject({ structuredOutput: true, providerSchemaHash: psHash() });
      expect(t.providerAttempts!.map((a) => [a.kind, a.outcome])).toEqual([['initial', 'FAILED'], ['diagnostic_retry', 'FAILED']]);
    }
    // Classification : une requête refusée n'est pas une panne — reste TRANSITOIRE comme avant (politique T1 inchangée).
    expect(isDefinitiveGatewayFailure(err)).toBe(false);
  });

  it('retry en échec pour une AUTRE cause : l’erreur d’origine (400) reste la cause enregistrée', async () => {
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      throw Object.assign(new Error('{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}'), { status: 503 });
    });
    await expect(AiGateway.execute(requete())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(traces()[0]).toMatchObject({ failure: { family: 'INPUT_ERROR' } });
    expect(traces()[0].providerAttempts![1]).toMatchObject({ kind: 'diagnostic_retry', outcome: 'FAILED', httpStatus: 503, family: 'PROVIDER_ERROR' });
  });

  it('modèle 1 : 400 puis 400 ; modèle 2 : 400 puis succès → la cascade s’arrête au modèle 2', async () => {
    let premier: string | null = null;
    fake.onAny((input) => {
      premier ??= input.model;
      if (input.model === premier || input.responseSchema) throw invalidArgument();
      return { rawText: groupOk(), inputTokens: 1, outputTokens: 1 };
    });
    const res = await AiGateway.execute(requete());
    expect(res.usedFallback).toBe(true);
    expect(analyses()).toHaveLength(4);
    expect(new Set(analyses().map((c) => c.model)).size).toBe(2);
    expect(schemaRejectedRecently(premier!, contrat().schemaHash)).toBe(false);
    expect(schemaRejectedRecently(res.model, contrat().schemaHash)).toBe(true);
  });
});

describe('AC4 — refus explicite du schéma : comportement existant conservé', () => {
  it('« response_schema is too complex » → retry sans schéma (STRUCTURED_OUTPUT_REJECTED), mémorisé', async () => {
    fake.onAny((input) => {
      if (input.responseSchema) throw Object.assign(new Error('Invalid JSON payload: response_schema is too complex'), { status: 400 });
      return { rawText: groupOk(), inputTokens: 1, outputTokens: 1 };
    });
    const res = await AiGateway.execute(requete());
    expect(res.usedFallback).toBe(false);
    expect(analyses().map((c) => c.responseSchema !== undefined)).toEqual([true, false]);
    expect(schemaRejectedRecently(res.model, contrat().schemaHash)).toBe(true);
    expect(traces()[0].providerMeta?.structuredOutput).toBe('schema_rejected_retried_without');
    expect(traces()[0].providerAttempts!.map((a) => a.kind)).toEqual(['initial', 'schema_rejected_retry']);
    expect(classifyCallError(Object.assign(new Error('response_schema is too complex'), { status: 400 }))).toMatchObject({ subtype: 'STRUCTURED_OUTPUT_REJECTED' });
  });
});

describe('AC5 — erreur d’authentification (400 INVALID_ARGUMENT « API key not valid »)', () => {
  it('AUTH_ERROR, aucun retry diagnostique sans schéma', async () => {
    const auth = () => Object.assign(new Error('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'), { status: 400 });
    expect(classifyCallError(auth())).toMatchObject({ family: 'AUTH_ERROR' });
    fake.onAny(() => { throw auth(); });
    // Lot 87A (CDC P7 §8, R10) : clé refusée = accès GLOBAL — aucune cascade inutile,
    // suspension (reprise possible après correction de la clé).
    await expect(AiGateway.execute(requete())).rejects.toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'GLOBAL_ACCESS' });
    expect(analyses().every((c) => c.responseSchema !== undefined)).toBe(true);
    expect(analyses()).toHaveLength(1);
    const appels = traces().filter((t) => t.providerAttempts);
    expect(appels.every((t) => t.failure?.family === 'AUTH_ERROR' && t.providerAttempts!.length === 1)).toBe(true);
    expect(traces().filter((t) => t.errorCode === 'FALLBACK_NOT_ADMISSIBLE')).toHaveLength(2);
  });
});

describe('AC6 — contexte trop grand (400 « input token count exceeds… »)', () => {
  it('CONTEXT_TOO_LARGE, aucun retry sans schéma', async () => {
    const trop = () => Object.assign(new Error('{"error":{"code":400,"message":"The input token count (1250000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}'), { status: 400 });
    expect(classifyCallError(trop())).toMatchObject({ family: 'CONTEXT_TOO_LARGE' });
    fake.onAny(() => { throw trop(); });
    await expect(AiGateway.execute(requete())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(analyses()).toHaveLength(3);
    expect(analyses().every((c) => c.responseSchema !== undefined)).toBe(true);
  });

  it('jamais pour RATE_LIMIT, SAFETY_BLOCK, TIMEOUT, NETWORK_ERROR (non génériques)', () => {
    const cas = [
      Object.assign(new Error('Resource has been exhausted'), { status: 429 }),
      Object.assign(new Error('Response was blocked due to SAFETY'), { blocked: true }),
      Object.assign(new Error('Délai dépassé'), { code: 'TIMEOUT' }),
      Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }),
    ];
    expect(cas.map((e) => classifyCallError(e).family)).toEqual(['RATE_LIMIT', 'SAFETY_BLOCK', 'TIMEOUT', 'NETWORK_ERROR']);
    expect(cas.some((e) => isGenericInvalidArgument(classifyCallError(e)))).toBe(false);
  });
});

describe('AC7 — AI_STRUCTURED_OUTPUT=off : aucune modification de comportement', () => {
  it('aucun responseSchema, aucun appel supplémentaire : un 400 passe au modèle suivant comme avant', async () => {
    process.env.AI_STRUCTURED_OUTPUT = 'off';
    fake.onAny(() => { throw invalidArgument(); });
    await expect(AiGateway.execute(requete())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    // Lot 87A (R57) : 400 générique = cause indéterminée → un seul essai alternatif.
    expect(analyses()).toHaveLength(2);
    expect(analyses().every((c) => c.responseSchema === undefined)).toBe(true);
    expect(new Set(analyses().map((c) => c.model)).size).toBe(2);
    expect(traces()[0].providerRequest).toMatchObject({ responseSchemaSent: false, schemaOmittedReason: 'structured_output_off', providerSchemaHash: null });
    // Le schéma dérivé reste joint au prompt (comportement lot 34D).
    expect(analyses()[0].prompt).toContain(rc.contractJsonSchemaText(contrat()));
  });
});

describe('AC8 — aucun schéma prévu pour l’opération', () => {
  it('opération sans structured output : aucun retry supplémentaire', async () => {
    fake.onAny(() => { throw invalidArgument(); });
    await expect(AiGateway.execute(requete({ jsonResponse: false }))).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    // Lot 87A (R57) : 400 générique = cause indéterminée → un seul essai alternatif.
    expect(analyses()).toHaveLength(2);
    expect(analyses().every((c) => c.responseSchema === undefined)).toBe(true);
    expect(traces()[0].providerRequest).toMatchObject({ responseSchemaSent: false, schemaOmittedReason: 'not_requested', responseMimeType: null });
    expect(traces().filter((t) => t.providerAttempts).every((t) => t.providerAttempts!.length === 1)).toBe(true);
  });
});

describe('AC9 — contrat runtime invariant entre la tentative structurée et le retry diagnostique', () => {
  it('contractId, contractVersion, schemaVersion, schemaHash, compatTableVersion identiques ; schéma DÉRIVÉ joint au prompt', async () => {
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: groupOk(), inputTokens: 1, outputTokens: 1 };
    });
    await AiGateway.execute(requete());
    const c = contrat();
    const [avec, sans] = analyses();
    // Première tentative : contrat annoncé, schéma imposé par le structured output.
    expect(avec.responseSchema).toEqual(providerJsonSchema(c.canonical).schema);
    expect(avec.prompt).toContain(`${c.contractId} v${c.contractVersion} · schéma ${c.schemaVersion} · empreinte ${c.schemaHash}`);
    expect(avec.prompt).not.toContain(rc.contractJsonSchemaText(c));
    // Retry : MÊME contrat (runtimeContractBlock(…, schemaInPrompt: true)), JSON natif conservé.
    expect(sans.prompt).toContain(`${c.contractId} v${c.contractVersion} · schéma ${c.schemaVersion} · empreinte ${c.schemaHash}`);
    expect(sans.prompt).toContain(rc.contractJsonSchemaText(c));
    expect(sans.prompt.replace(rc.runtimeContractBlock(c, { schemaInPrompt: true }), ''))
      .toBe(avec.prompt.replace(rc.runtimeContractBlock(c, { schemaInPrompt: false }), ''));
    expect(sans.jsonResponse).toBe(true);
    expect(describeGenerationConfig({ model: sans.model, jsonResponse: sans.jsonResponse })).toMatchObject({ responseSchemaSent: false, responseMimeType: 'application/json' });
    expect(sans).toMatchObject({ model: avec.model, maxOutputTokens: avec.maxOutputTokens, reasoning: avec.reasoning, attachments: avec.attachments });
    expect(traces()[0].runtimeContract).toMatchObject({
      contractId: c.contractId, contractVersion: c.contractVersion, schemaVersion: c.schemaVersion,
      schemaHash: c.schemaHash, compatTableVersion: c.compatTableVersion,
    });
  });
});

describe('Classification BO — fournisseur indisponible ≠ requête refusée ≠ structured output refusé', () => {
  it('un 400 INVALID_ARGUMENT n’est jamais « fournisseur indisponible »', () => {
    expect(providerFailureCategory('INPUT_ERROR', null)).toBe('REQUEST_REJECTED');
    expect(providerFailureCategory('INVALID_OUTPUT', 'STRUCTURED_OUTPUT_REJECTED')).toBe('STRUCTURED_OUTPUT_REJECTED');
    expect(providerFailureCategory('PROVIDER_ERROR', null)).toBe('PROVIDER_UNAVAILABLE');
    expect(gatewayCodeOf(invalidArgument(), classifyCallError(invalidArgument()))).toBe('PROVIDER_REQUEST_REJECTED');
    const panne = Object.assign(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'), { status: 503 });
    expect(gatewayCodeOf(panne, classifyCallError(panne))).toBe('PROVIDER_UNAVAILABLE');
    // Traces antérieures (PROVIDER_UNAVAILABLE + famille INPUT_ERROR) : affichage corrigé, sans réécriture.
    expect(displayErrorCode('PROVIDER_UNAVAILABLE', 'INPUT_ERROR')).toBe('PROVIDER_REQUEST_REJECTED');
    expect(displayErrorCode('PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR')).toBe('PROVIDER_UNAVAILABLE');
    expect(displayErrorCode('INVALID_OUTPUT', 'INVALID_OUTPUT', 'MALFORMED_JSON')).toBe('INVALID_OUTPUT');
  });

  it('diagnostic d’exécution : compteurs distincts et constat du retry', async () => {
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument();
      return { rawText: groupOk(), inputTokens: 1, outputTokens: 1 };
    });
    await AiGateway.execute(requete());
    const t = traces()[0];
    const d = buildExecutionDiagnosis({
      treatment: 'T1', diagnostics: [], job: { status: 'DONE', attempts: 1 },
      calls: [{
        id: 1, model: t.model, modelRank: 'primary', status: 'success', callKind: 'analysis', usedFallback: false,
        inputTokens: 1, outputTokens: 1, durationMs: 1, costMicros: 0, errorCode: null, errorMessage: null,
        providerAttempts: t.providerAttempts, providerRequest: t.providerRequest,
      } as never],
    });
    expect(d.counters).toEqual({ jobAttempts: 1, modelCalls: 1, modelFallbacks: 0, structuredOutputRetries: 1, repairCalls: 0 });
    expect(d.finalDiagnosis.join(' ')).toMatch(/HTTP 400 INVALID_ARGUMENT avec structured output \(schéma fournisseur [0-9a-f]{12}\) ; essai diagnostique du même modèle sans responseSchema réussi/);
  });
});

describe('Observabilité — requête fournisseur sans contenu', () => {
  it('thinkingConfig effectif et pièces jointes (nombre, MIME, transport)', () => {
    expect(describeGenerationConfig({ model: 'gemini-3.6-flash', reasoning: 'minimal', maxOutputTokens: 8000, jsonResponse: true }))
      // Lot 85C : température et refus éventuel décrits aussi (constructeur unique).
      .toEqual({ responseSchemaSent: false, responseMimeType: 'application/json', maxOutputTokens: 8000, thinkingConfig: 'low', temperature: 0, refused: null });
    expect(describeGenerationConfig({ model: 'gemini-2.5-flash', reasoning: 'étendu' }).thinkingConfig).toBe('budget 24576');
    expect(describeGenerationConfig({ model: 'gemini-3.6-flash' })).toMatchObject({ thinkingConfig: 'aucun', responseMimeType: null, maxOutputTokens: null });
    expect(describeAttachments([
      { url: 'https://s3.example.com/a.pdf?sig', mimeType: 'application/pdf' },
      { url: 'https://s3.example.com/b.png?sig', mimeType: 'image/png' },
      { url: 'x', mimeType: 'image/jpeg', data: 'AAAA' },
      { url: 'https://s3.example.com/c.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    ])).toEqual({ count: 4, items: [
      { mimeType: 'application/pdf', transport: 'files_api' },
      { mimeType: 'image/png', transport: 'inline' },
      { mimeType: 'image/jpeg', transport: 'inline' },
      { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', transport: 'text_extracted' },
    ] });
  });
});
