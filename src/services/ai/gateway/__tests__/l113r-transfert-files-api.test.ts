/**
 * Lot 113R (carte #717) — « Résoudre le 403 Files API, conserver sa cause et
 * reprendre automatiquement les analyses ». Unitaires SANS base.
 *
 *   L113R-U01  Files API simulée : 403 avec message (ErrorInfo, en-tête de
 *              requête), corps non JSON, corps vide, 429, 5xx, réseau,
 *              activation échouée → échec STRUCTURÉ, sans secret
 *   L113R-U02  vraie erreur LOCALE de construction : inchangée (REQUEST_BUILD)
 *   L113R-U03  adaptateur Gemini : lecture du stockage puis envoi refusé →
 *              étape réelle `attachment_transfer` (jamais `request_build`)
 *   L113R-U04  classification structurée (famille, étape) et cause (politique)
 *   L113R-U05  passerelle : 403 au transfert → SUSPENSION, aucun secours (même
 *              transport), dépendance commune décrite, usedFallback faux,
 *              disjoncteur non avancé, réponse figée avec la tentative
 *   L113R-U06  diagnostic d'exécution et export : refus d'envoi ≠ génération,
 *              secours non appelés présentés comme tels, compteurs réconciliés
 *   L113R-U07  file : attente longue (jamais d'abandon) après les reprises
 *              rapprochées ; statut utilisateur « attente technique »
 *   L113R-U08  lecture de la réponse : hypothèses, jamais une conclusion
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>>, outcomes: [] as Array<Record<string, unknown>>, diags: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async (d: Record<string, unknown>) => { h.diags.push(d); }),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push(t); return h.traces.length; }),
}));
vi.mock('../../queue/circuit-breaker.repository', async (orig) => ({
  ...(await orig<typeof import('../../queue/circuit-breaker.repository')>()),
  noteGatewayOutcome: vi.fn((o: Record<string, unknown>) => { h.outcomes.push(o); }),
}));

const F = await import('../providers/gemini-files');
const { classifyCallError, finalDiagnosis } = await import('../diagnostics/classify');
const P = await import('../fallback-policy');
const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setFallbackContextForTests } = await import('../fallback-context');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

const CLE = 'AIzaSyD-cle-de-test-l113r-0123456789abcdef';
const pdf = Buffer.from('%PDF-1.4 test');
const meta = { mimeType: 'application/pdf', displayName: 'facture.pdf' };

type Rep = { status: number; body?: string; headers?: Record<string, string> };
/** Files API simulée : une réponse par appel, dans l'ordre. */
function filesApi(...reps: Array<Rep | Error>) {
  const calls: string[] = [];
  const f = async (input: string | Request): Promise<Response> => {
    calls.push(typeof input === 'string' ? input : input.url);
    const r = reps.shift();
    if (!r) throw new Error('aucune réponse simulée');
    if (r instanceof Error) throw r;
    return new Response(r.body ?? null, { status: r.status, headers: r.headers ?? {} });
  };
  return Object.assign(f, { calls });
}
const google = (code: number, status: string, message: string, details: unknown[] = []) =>
  JSON.stringify({ error: { code, status, message, details } });
const ERRINFO_403 = google(403, 'PERMISSION_DENIED', `Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.FileService.CreateFile are blocked. key=${CLE}`, [
  { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com', consumer: 'projects/123456789' } },
]);

async function echec(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).not.toBeNull();
  return e as Error & { transfer: import('../diagnostics/taxonomy').AttachmentTransferFailure; aiStage?: string };
}

describe('L113R-U01 — Files API simulée : échec structuré, sans secret', () => {
  it('403 avec message : statut, code, message, raison, détails, identifiant de requête, endpoint sans clé', async () => {
    const api = filesApi({ status: 403, body: ERRINFO_403, headers: { 'content-type': 'application/json', 'x-guploader-uploadid': 'UP-123' } });
    const e = await echec(F.transferBufferToFilesApi(pdf, meta, CLE, api));
    expect(e).toBeInstanceOf(F.AttachmentTransferError);
    expect(e.aiStage).toBe('attachment_transfer');
    expect(e.transfer).toMatchObject({
      format: 'transfer-v1', step: 'provider_upload', kind: 'http', httpStatus: 403, providerStatus: 'PERMISSION_DENIED', providerCode: 403,
      providerReason: 'API_KEY_SERVICE_BLOCKED', providerDomain: 'googleapis.com', requestId: 'UP-123', providerDetail: 'STRUCTURED',
      endpoint: 'POST generativelanguage.googleapis.com/upload/v1beta/files', generationRequested: false,
      providerMetadata: { service: 'generativelanguage.googleapis.com', consumer: 'projects/123456789' },
    });
    expect(e.transfer.providerMessage).toMatch(/are blocked/);
    expect(e.transfer.details).toHaveLength(1);
    // Aucun secret, nulle part (message, corps, détails).
    expect(JSON.stringify(e.transfer)).not.toContain(CLE);
    expect(e.message).toMatch(/HTTP 403 PERMISSION_DENIED \/ API_KEY_SERVICE_BLOCKED/);
    expect(api.calls[0]).toContain('upload/v1beta/files?key=');
  });

  it('corps NON JSON (page HTML d’un frontal) : extrait borné et masqué, absence de raison signalée', async () => {
    const html = `<html><body>403 Forbidden ${'x'.repeat(5000)} key=${CLE}</body></html>`;
    const e = await echec(F.transferBufferToFilesApi(pdf, meta, CLE, filesApi({ status: 403, body: html, headers: { 'content-type': 'text/html' } })));
    expect(e.transfer).toMatchObject({ httpStatus: 403, providerStatus: null, providerMessage: null, providerDetail: 'TEXT', body: { kind: 'text', truncated: true } });
    expect(e.transfer.body.excerpt!.length).toBeLessThanOrEqual(2001);
    expect(e.transfer.body.length).toBe(html.length);
    expect(JSON.stringify(e.transfer)).not.toContain(CLE);
    expect(e.message).toMatch(/réponse non JSON du fournisseur/);
  });

  it('corps VIDE : aucun détail fourni, signalé explicitement (aucune cause inventée)', async () => {
    const e = await echec(F.transferBufferToFilesApi(pdf, meta, CLE, filesApi({ status: 403, body: '' })));
    expect(e.transfer).toMatchObject({ httpStatus: 403, providerDetail: 'NONE', body: { kind: 'empty', length: 0 }, providerMessage: null, providerReason: null });
    expect(e.message).toMatch(/aucun détail fourni par le fournisseur/);
    const c = classifyCallError(e);
    expect(c.providerErrorMessage).toMatch(/aucun détail fourni par le fournisseur/);
  });

  it('429, 5xx, réseau, activation échouée : nature et étape réelles', async () => {
    const q = await echec(F.transferBufferToFilesApi(pdf, meta, CLE, filesApi({ status: 429, body: google(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded') })));
    expect(q.transfer).toMatchObject({ httpStatus: 429, providerStatus: 'RESOURCE_EXHAUSTED' });
    const s = await echec(F.transferBufferToFilesApi(pdf, meta, CLE, filesApi({ status: 503, body: google(503, 'UNAVAILABLE', 'overloaded') })));
    expect(s.transfer).toMatchObject({ httpStatus: 503, step: 'provider_upload' });
    const reseau = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const n = await echec(F.transferBufferToFilesApi(pdf, meta, CLE, filesApi(reseau)));
    expect(n.transfer).toMatchObject({ kind: 'network', networkCode: 'ECONNRESET', httpStatus: null, providerDetail: 'NONE' });
    const a = await echec(F.transferBufferToFilesApi(pdf, meta, CLE, filesApi(
      { status: 200, body: JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', name: 'files/abc', state: 'PROCESSING' } }) },
      { status: 200, body: JSON.stringify({ state: 'FAILED' }) },
      { status: 200, body: '' }, // suppression du fichier temporaire
    )));
    expect(a.transfer).toMatchObject({ step: 'file_activation', kind: 'activation_failed' });
    const vide = await echec(F.transferBufferToFilesApi(pdf, meta, CLE, filesApi({ status: 200, body: '{}' })));
    expect(vide.transfer).toMatchObject({ kind: 'invalid_response', httpStatus: 200 });
  });

  it('réussite : URI rendue (fichier ACTIVE)', async () => {
    const uri = await F.transferBufferToFilesApi(pdf, meta, CLE, filesApi({ status: 200, body: JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/ok', state: 'ACTIVE' } }) }));
    expect(uri).toMatch(/files\/ok$/);
  });

  it('URL signée du stockage jamais conservée (signature masquée, hôte seul)', () => {
    expect(F.endpointOf('GET', 'https://s3.gra.io.cloud.ovh.net/b/doc.pdf?X-Amz-Signature=abc&X-Amz-Credential=def', { hostOnly: true }))
      .toBe('GET s3.gra.io.cloud.ovh.net (URL signée masquée)');
    expect(F.sanitizeTransferText(`https://x/y?X-Amz-Signature=secret1&key=${CLE}`)).not.toMatch(/secret1|AIza/);
  });
});

describe('L113R-U02 — vraie erreur LOCALE de construction : inchangée', () => {
  it('en-tête impossible à construire : AttachmentRequestBuildError, INTERNAL_ERROR / request_build, défaut commun', async () => {
    const e = await F.transferBufferToFilesApi(pdf, { mimeType: 'application/pdf\u0105', displayName: 'x' }, CLE, filesApi()).catch((x) => x);
    expect(e).toBeInstanceOf(F.AttachmentRequestBuildError);
    const c = classifyCallError(Object.assign(new Error(e.message), { code: 'REQUEST_BUILD_FAILED' }));
    expect(c).toMatchObject({ family: 'INTERNAL_ERROR', stage: 'request_build' });
    expect(P.causeOfFailure({ family: c.family, stage: c.stage })).toBe('COMMON_DEFECT');
  });
});

describe('L113R-U03 — adaptateur Gemini : étape réelle du transfert', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    (await import('../../provider/provider-secret')).setProviderSecretResolver(null);
  });
  it('stockage lu puis envoi refusé (403) : `attachment_transfer`, jamais requalifié en `request_build`', async () => {
    (await import('../../provider/provider-secret')).setProviderSecretResolver(async () => CLE);
    const api = filesApi({ status: 200, body: '%PDF-1.4' }, { status: 403, body: ERRINFO_403, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', api);
    const { GeminiProvider } = await import('../providers/gemini.provider');
    const e = await new GeminiProvider().call({
      model: 'gemini-x', prompt: 'p', timeoutMs: 5_000, attachments: [{ url: 'https://s3.example.net/doc.pdf?X-Amz-Signature=sig', mimeType: 'application/pdf', displayName: 'doc.pdf' }],
    } as never).catch((x) => x);
    expect(e.aiStage).toBe('attachment_transfer');
    expect(e.transfer).toMatchObject({ step: 'provider_upload', httpStatus: 403 });
    expect(api.calls).toHaveLength(2);
  });
  it('lecture du stockage en échec : étape `source_download`, défaut LOCAL (jamais un refus Google)', async () => {
    (await import('../../provider/provider-secret')).setProviderSecretResolver(async () => CLE);
    vi.stubGlobal('fetch', filesApi({ status: 403, body: '<Error>AccessDenied</Error>' }));
    const { GeminiProvider } = await import('../providers/gemini.provider');
    const e = await new GeminiProvider().call({
      model: 'gemini-x', prompt: 'p', timeoutMs: 5_000, attachments: [{ url: 'https://s3.example.net/doc.pdf?X-Amz-Signature=sig', mimeType: 'application/pdf' }],
    } as never).catch((x) => x);
    expect(e.transfer).toMatchObject({ step: 'source_download', endpoint: 'GET s3.example.net (URL signée masquée)' });
    expect(JSON.stringify(e.transfer)).not.toContain('Signature=sig');
    const c = classifyCallError(e);
    expect(c).toMatchObject({ family: 'INTERNAL_ERROR', stage: 'attachment_transfer' });
    expect(P.causeOfFailure({ family: c.family, stage: c.stage, transferKind: e.transfer.kind })).toBe('TRANSFER_REJECTED');
  });
});

describe('L113R-U04 — classification structurée, jamais sur le texte', () => {
  const t = (over: Partial<import('../diagnostics/taxonomy').AttachmentTransferFailure>) => new F.AttachmentTransferError(F.buildTransferFailure({
    step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 403, ...over as object,
  } as never));
  const famille = (e: Error) => classifyCallError(e);
  it.each([
    [{ status: 403 }, 'AUTH_ERROR', 'TRANSFER_ACCESS_DENIED'],
    [{ status: 401 }, 'AUTH_ERROR', 'TRANSFER_ACCESS_DENIED'],
    [{ status: 429 }, 'RATE_LIMIT', 'TRANSFER_UNAVAILABLE'],
    [{ status: 500 }, 'PROVIDER_ERROR', 'TRANSFER_UNAVAILABLE'],
    [{ status: 503 }, 'PROVIDER_ERROR', 'TRANSFER_UNAVAILABLE'],
    [{ status: null, kind: 'network', networkCode: 'ENOTFOUND' }, 'NETWORK_ERROR', 'TRANSFER_UNAVAILABLE'],
    [{ status: null, kind: 'activation_timeout', step: 'file_activation' }, 'TIMEOUT', 'TRANSFER_UNAVAILABLE'],
    [{ status: 200, kind: 'activation_failed', step: 'file_activation' }, 'PROVIDER_ERROR', 'TRANSFER_REJECTED'],
    [{ status: 400 }, 'INPUT_ERROR', 'TRANSFER_REJECTED'],
    [{ status: 413 }, 'CONTEXT_TOO_LARGE', 'TRANSFER_REJECTED'],
  ])('%o → %s / %s', (over, family, cause) => {
    const e = t(over as never);
    const c = famille(e);
    expect(c).toMatchObject({ family, stage: 'attachment_transfer', subtype: null });
    expect(c.transfer).toBe(e.transfer);
    expect(P.causeOfFailure({ family: c.family, stage: c.stage, providerErrorCode: c.providerErrorCode, transferKind: e.transfer.kind })).toBe(cause);
  });
  it('400 FAILED_PRECONDITION (région, projet) : accès, pas un défaut du fichier', () => {
    const e = t({ status: 400, bodyText: google(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.'), headers: new Headers({ 'content-type': 'application/json' }) } as never);
    const c = famille(e);
    expect(P.causeOfFailure({ family: c.family, stage: c.stage, providerErrorCode: c.providerErrorCode })).toBe('TRANSFER_ACCESS_DENIED');
  });
  it('l’ancien texte « HTTP 403 » sans structure n’est plus la source de classification (non attribué au prompt)', () => {
    const c = classifyCallError(Object.assign(new Error('Upload Files API échoué : HTTP 403'), { aiStage: 'request_build' }));
    // Comportement historique conservé pour une erreur NON structurée : la
    // nouvelle chaîne ne produit plus jamais cette forme (voir U01/U03).
    expect(c.stage).toBe('request_build');
  });
  it('la politique décrit la dépendance commune RÉELLE (transport et accès), jamais « prompt / contrat »', () => {
    for (const cause of ['TRANSFER_ACCESS_DENIED', 'TRANSFER_UNAVAILABLE', 'TRANSFER_REJECTED'] as const) {
      const pol = P.CAUSE_POLICY[cause];
      expect(pol).toMatchObject({ fallback: 'STOP', countsForBreaker: false });
      expect(pol.commonDependency).toMatch(/envoi|pièce jointe/);
      expect(pol.commonDependency).not.toMatch(/prompt|contrat/);
    }
    expect(P.CAUSE_POLICY.TRANSFER_ACCESS_DENIED.suspendWithoutFallback).toBe(true);
    expect(P.CAUSE_POLICY.TRANSFER_REJECTED.suspendWithoutFallback).toBe(false);
  });
});

describe('L113R-U05 — passerelle : 403 au transfert', () => {
  const Schema = t1Schema({ ok: z.boolean() });
  let fake: InstanceType<typeof FakeProvider>;
  const traces = () => h.traces as Array<Record<string, unknown> & { capture?: { callKind: string } }>;
  const req = () => ({
    useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 13,
    sourceIds: [387], promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `l113r-${Math.random()}`,
  });
  const refus403 = () => new F.AttachmentTransferError(F.buildTransferFailure({
    step: 'provider_upload', kind: 'http', endpoint: 'POST generativelanguage.googleapis.com/upload/v1beta/files', secret: CLE,
    status: 403, headers: new Headers({ 'content-type': 'application/json', 'x-guploader-uploadid': 'UP-9302' }), bodyText: ERRINFO_403,
  }));
  beforeEach(() => {
    h.traces.length = 0; h.outcomes.length = 0; h.diags.length = 0;
    fake = new FakeProvider();
    setAiProvider(fake);
    __setConfigForTests({ versionId: 1, entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: 'm-b', fallback2: 'm-c', maxOutputTokens: 2000 }] });
  });
  afterEach(() => { __setConfigForTests(null); __setFallbackContextForTests(null); });

  it('suspension (jamais un échec classique), aucun secours sur le même transport, dépendance décrite, usedFallback faux', async () => {
    fake.onAny(() => { throw refus403(); });
    const e = await AiGateway.execute(req()).catch((x) => x);
    expect(e).toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'TRANSFER_ACCESS_DENIED', lastFailureCode: 'ATTACHMENT_TRANSFER_FAILED' });
    expect(e.transfer).toMatchObject({ httpStatus: 403, providerReason: 'API_KEY_SERVICE_BLOCKED', requestId: 'UP-9302', model: 'm-a' });
    expect(fake.calls).toHaveLength(1);
    const [appel, ...nonAppeles] = traces();
    expect(appel).toMatchObject({
      model: 'm-a', errorCode: 'ATTACHMENT_TRANSFER_FAILED', usedFallback: false, inputTokens: 0, outputTokens: 0, costMicros: 0, billable: false,
      failure: { family: 'AUTH_ERROR', stage: 'attachment_transfer' },
      transfer: { httpStatus: 403, providerStatus: 'PERMISSION_DENIED', generationRequested: false },
    });
    expect(nonAppeles).toHaveLength(2);
    for (const t of nonAppeles) {
      expect(t).toMatchObject({ errorCode: 'FALLBACK_NOT_ADMISSIBLE', usedFallback: false, fallback: { decision: 'SHARED_TRANSFER', afterCause: 'TRANSFER_ACCESS_DENIED' } });
      expect((t.fallback as { commonDependency?: string }).commonDependency).toMatch(/même clé, le même projet et le même service de fichiers/);
    }
    expect(nonAppeles.map((t) => t.modelRank)).toEqual(['fallback_1', 'fallback_2']);
    // Diagnostic de la tentative : réponse figée, jamais attribuée au prompt / modèle.
    expect(h.diags[0]).toMatchObject({ diagnostic: { family: 'AUTH_ERROR', stage: 'attachment_transfer', transfer: { httpStatus: 403 } } });
    // Disjoncteur : un transfert refusé n'est pas une panne du modèle.
    expect(h.outcomes[0]).toMatchObject({ attempts: [], chainSucceeded: null });
  });

  it('fichier refusé (400) : échec ordinaire sans secours ; 503 au transfert : suspension', async () => {
    fake.onAny(() => { throw new F.AttachmentTransferError(F.buildTransferFailure({ step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 400 })); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'ATTACHMENT_TRANSFER_FAILED' });
    // Ni secours, ni « essai diagnostique sans schéma » (le même envoi échouerait).
    expect(fake.calls).toHaveLength(1);
    h.traces.length = 0;
    fake.onAny(() => { throw new F.AttachmentTransferError(F.buildTransferFailure({ step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 503 })); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'AI_SUSPENDED', failureCause: 'TRANSFER_UNAVAILABLE' });
  });

  it('rétablissement : la tentative suivante réussit, la cause initiale reste sur SA trace (jamais écrasée)', async () => {
    fake.onAny(() => { throw refus403(); });
    await AiGateway.execute(req()).catch(() => null);
    const avant = traces()[0];
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-a');
    expect(traces()[0]).toBe(avant);
    expect(traces()[0]).toMatchObject({ transfer: { httpStatus: 403 } });
    expect(traces().at(-1)).toMatchObject({ status: 'success' });
    expect(traces().at(-1)?.transfer).toBeUndefined();
  });
});

describe('L113R-U06 — diagnostic d’exécution et export', () => {
  const ligne = (over: Record<string, unknown>) => ({
    id: 1, createdAt: new Date('2026-11-06T19:05:00Z'), useCaseCode: 'SOURCE_ANALYSIS', treatment: 'T1', operationCode: 't1_analyze_document',
    accountId: 13, userId: null, provider: 'gemini', model: 'm-a', modelRank: 'primary', usedFallback: false, inputTokens: 0, outputTokens: 0,
    costMicros: 0, durationMs: 120, status: 'error', errorCode: 'ATTACHMENT_TRANSFER_FAILED', errorMessage: 'Envoi refusé', configVersionId: 1,
    configVisibleNumber: 1, appVersion: null, jobId: 6775, promptVersion: null, objectType: 'asset_file', objectId: '387', trigger: null, origin: null,
    callerMode: null, task: 'ANALYZE_DOCUMENT', masterPromptCode: null, masterPromptVersion: null, reasoning: null, maxOutputTokens: null, engine: 'new',
    callTrigger: null, callKind: 'analysis' as const, failure: { family: 'AUTH_ERROR', subtype: null, stage: 'attachment_transfer', signature: 's' },
    providerMeta: null, repaired: false, runtimeContract: null, transformations: null, structuredContext: null, jobAttempt: 5, traceId: 'b0bb6228',
    transfer: F.buildTransferFailure({ step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 403 }),
    ...over,
  });
  const nonAppele = (id: number, rank: string) => ligne({
    id, model: `m-${rank}`, modelRank: rank, usedFallback: true /* trace antérieure trompeuse */, errorCode: 'FALLBACK_NOT_ADMISSIBLE',
    failure: null, transfer: null,
    fallbackDecision: { decision: 'CAUSE_STOPS_CHAIN', decisionLabel: 'la cause de l’échec rend tout secours inutile' },
  });

  it('rangs non appelés : ni appel, ni secours utilisé ; transfert refusé : aucune génération ; compteurs réconciliés', async () => {
    const { buildExecutionDiagnosis } = await import('../../telemetry/execution-diagnosis');
    const { buildExecutionExport } = await import('../../telemetry/execution-export');
    const calls = [ligne({}), nonAppele(2, 'fallback_1'), nonAppele(3, 'fallback_2')];
    const d = buildExecutionDiagnosis({ treatment: 'T1', calls: calls as never, diagnostics: [], job: { status: 'FAILED', attempts: 5 } });
    expect(d.counters).toMatchObject({ jobAttempts: 5, modelCalls: 1, modelFallbacks: 0, notCalled: 2, transferFailures: 1, generationsRequested: 0 });
    expect(d.calls[0]).toMatchObject({ generationRequested: false, fallbackUsed: false, failureCategory: 'TRANSFER_REFUSED', transfer: { httpStatus: 403 } });
    for (const r of d.calls.slice(1)) expect(r).toMatchObject({ notCalled: true, fallbackUsed: false, generationRequested: false, configuredRank: expect.stringMatching(/^fallback_/) });
    const txt = d.finalDiagnosis.join(' ');
    expect(txt).toMatch(/échoué avant toute génération/);
    expect(txt).toMatch(/ni le prompt ni le modèle ne sont en cause/);
    expect(txt).not.toMatch(/n’a retourné aucune sortie/);
    const x = buildExecutionExport({ call: calls[0], calls, steps: [], inputs: [], modifications: [], job: null, t2: null, traceId: 'b0bb6228', diagnosis: d } as never);
    expect(x.costs).toMatchObject({ calls: 1, failedCalls: 1, notCalled: 2, transferFailures: 1, generationsRequested: 0 });
    expect(x.calls.map((c) => [c.usedFallback, c.notCalled, c.generationRequested])).toEqual([[false, false, false], [false, true, false], [false, true, false]]);
    expect(x.calls[0].transfer).toMatchObject({ httpStatus: 403 });
  });

  it('diagnostic final : corps vide signalé, sans cause inventée', () => {
    const tr = F.buildTransferFailure({ step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 403, bodyText: '' });
    const lignes = finalDiagnosis({ treatment: 'T1', succeeded: false, calls: [{ outcome: 'FAILED', callKind: 'analysis', family: 'AUTH_ERROR', subtype: null, stage: 'attachment_transfer', issues: [], signature: 's', outputReceived: false, repairs: [], transfer: tr }] });
    expect(lignes.join(' ')).toMatch(/aucun détail \(corps de réponse vide\)/);
  });
});

describe('L113R-U07 — file : jamais d’abandon silencieux ; statut utilisateur', () => {
  it('après les reprises rapprochées : attente longue (parked) pour un incident d’envoi, échec pour les autres causes', async () => {
    const { afterAiSuspension, transferParkRecheckSeconds } = await import('../../queue/queue-policy');
    expect(afterAiSuspension(0, 24, { park: true })).toMatchObject({ status: 'PENDING', count: 1, retryInSeconds: 300 });
    expect(afterAiSuspension(24, 24, { park: true })).toEqual({ status: 'PENDING', count: 25, retryInSeconds: transferParkRecheckSeconds(), parked: true });
    expect(afterAiSuspension(24, 24)).toMatchObject({ status: 'FAILED' });
    expect(transferParkRecheckSeconds()).toBe(24 * 3600);
  });
  it('travail suspendu pour un incident d’envoi : « en attente technique », jamais « analyse en cours », reprise prévue', async () => {
    const { computeProcessingStatus, displayAnalysisState, userMessageText } = await import('@/lib/ai/processing-status');
    const { documentStatusLabel } = await import('@/lib/documents/document-status-label');
    const v = computeProcessingStatus({ analysisState: 'UPLOADED', liveJob: { status: 'PENDING', attempts: 0, availableAt: '2026-11-07T08:00:00Z', technicalWaitCause: 'TRANSFER_ACCESS_DENIED' } });
    expect(v).toMatchObject({ processingStatus: 'PENDING', userMessageCode: 'ANALYSIS_WAITING_TECHNICAL', retryScheduled: true });
    const etat = displayAnalysisState('UPLOADED', v.processingStatus);
    expect(etat).toBe('UPLOADED');
    expect(documentStatusLabel(etat, v.processingStatus, v.userMessageCode)).toBe('Statut : en attente technique');
    expect(userMessageText(v.userMessageCode)).toMatch(/reprendra automatiquement, vous n’avez rien à faire/);
    // Une suspension d'une autre cause garde le comportement existant.
    const autre = computeProcessingStatus({ analysisState: 'UPLOADED', liveJob: { status: 'PENDING', attempts: 0, technicalWaitCause: 'QUOTA' } });
    expect(autre.userMessageCode).toBeNull();
  });
  it('charge utile du travail : réponse compacte (jamais le corps ni les détails complets)', async () => {
    const { compactTransfer } = await import('../../queue/queue-worker');
    const c = compactTransfer({ ...F.buildTransferFailure({ step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 403, bodyText: ERRINFO_403 }), model: 'm-a' } as never);
    expect(c).toMatchObject({ httpStatus: 403, providerStatus: 'PERMISSION_DENIED', model: 'm-a' });
    expect(c).not.toHaveProperty('body');
    expect(c).not.toHaveProperty('details');
  });
});

describe('L113R-U08 — lecture de la réponse : hypothèses à confirmer', () => {
  it('raison fournie → piste correspondante ; aucune raison → constat explicite, sans conclusion', async () => {
    const { transferHypotheses } = await import('../../transfer/transfer-hypotheses');
    const avec = transferHypotheses(F.buildTransferFailure({ step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 403, bodyText: ERRINFO_403, headers: new Headers({ 'content-type': 'application/json' }) }));
    expect(avec.map((x) => x.code)).toContain('KEY_API_RESTRICTION');
    expect(avec[0].text).toMatch(/^Hypothèse à confirmer/);
    const desactivee = transferHypotheses(F.buildTransferFailure({ step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 403,
      bodyText: google(403, 'PERMISSION_DENIED', 'Generative Language API has not been used in project 123 before or it is disabled.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }]) }));
    expect(desactivee.map((x) => x.code)).toContain('API_NOT_ENABLED');
    const vide = transferHypotheses(F.buildTransferFailure({ step: 'provider_upload', kind: 'http', endpoint: 'POST x', secret: null, status: 403, bodyText: '' }));
    expect(vide.map((x) => x.code)).toEqual(['ACCESS_DENIED_NO_REASON', 'NO_PROVIDER_DETAIL']);
    expect(vide.map((x) => x.text).join(' ')).toMatch(/aucune cause/);
  });
  it('PDF de test : valide, sans donnée utilisateur', async () => {
    const { probePdf } = await import('../../transfer/transfer-probe');
    const b = probePdf().toString('latin1');
    expect(b.startsWith('%PDF-1.4')).toBe(true);
    expect(b.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(b).toContain('Verebona - test d envoi');
  });
});
