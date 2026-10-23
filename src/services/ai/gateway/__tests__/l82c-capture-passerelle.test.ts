/**
 * Lot 82C — CDC Pilotage IA V2, phase P1 « capture complète à la source » :
 * tests unitaires de la PASSERELLE (fournisseur simulé, passerelle réelle).
 *
 *   L82C-CAP-01  réussite : prompt final réellement transmis, variables, ordre
 *                des messages, pièces jointes par référence, paramètres envoyés
 *                (plafond demandé / hérité / adapté / envoyé), réponse brute,
 *                sortie parsée et acceptée
 *   L82C-CAP-02  échec puis repli : la tentative en échec est capturée (aucune
 *                réponse, diagnostic), le repli hérite du plafond (tracé)
 *   L82C-CAP-03  réparation ciblée : capture distincte (callKind repair), la
 *                sortie d'origine erronée reste capturée
 *   L82C-CAP-04  essais internes du même modèle (schéma refusé) : les deux
 *                prompts transmis sont capturés
 *   L82C-CAP-05  refus avant appel (contrat T4 violé…) : capture « aucun envoi »
 *   L82C-CAP-06  T2 (assistant) : réponse capturée, rattachée à la conversation
 *   L82C-DUR-01  durée PROPRE par tentative (plus de cumul) + durée murale
 *   L82C-PAR-01  paramètre refusé (incident 4694) : PARAMETER_REJECTED avec le
 *                paramètre, jamais « fournisseur indisponible », pas d'essai
 *                diagnostique sans schéma inutile
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type { CallCaptureInput } from '../../telemetry/call-capture';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push(t); return h.traces.length; }),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { clearSchemaRejections } = await import('../output-resolution/provider-schema');
const { classifyCallError, rejectedParameterOf, isGenericInvalidArgument } = await import('../diagnostics/classify');
const { providerFailureCategory, displayCause } = await import('../diagnostics/taxonomy');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');
const { t2MasterVariables } = await import('../../assistant/master/t2-answer');
const { asTestContract } = await import('../output-resolution/runtime-contract');

type Trace = Record<string, unknown> & {
  durationMs: number; executionElapsedMs?: number; status: string; errorCode?: string; callKind?: string;
  failure?: { family: string; subtype: string | null; parameter?: string };
  capture?: CallCaptureInput;
};
const traces = () => h.traces as Trace[];
const cap = (i: number) => traces()[i].capture!;

const Schema = t1Schema({ ok: z.boolean() });
let fake: InstanceType<typeof FakeProvider>;

function t1(primary: string, f1: string | null, maxOutputTokens: number | null = 4000) {
  return { ...emptyTreatmentConfig('T1'), primaryModel: primary, fallback1: f1, fallback2: null, maxOutputTokens };
}
const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7, userId: 3,
  sourceIds: [42], promptVariables: t1TestVariables('facture IBAN FR76 3000 6000 0112 3456 7890 189'),
  outputSchema: Schema, idempotencyKey: `l82c-${Math.random()}`,
  attachments: [{ url: 'https://bucket.s3.eu-west-3.amazonaws.com/docs/42.pdf?X-Amz-Signature=secret&X-Amz-Credential=k', mimeType: 'application/pdf', displayName: 'facture.pdf' }],
  ...over,
});
const invalidArgument = (message: string) => Object.assign(
  new Error(`{"error":{"code":400,"message":"${message}","status":"INVALID_ARGUMENT"}}`), { name: 'ClientError', status: 400 },
);

beforeEach(() => {
  h.traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  clearSchemaRejections();
  delete process.env.AI_OUTPUT_REPAIR_PASS;
  delete process.env.AI_STRUCTURED_OUTPUT;
});
afterEach(() => __setConfigForTests(null));

describe('L82C-CAP — capture à la source, toutes tentatives', () => {
  it('L82C-CAP-01 — réussite : prompt réellement transmis, contexte, paramètres, réponse brute et sortie parsée', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b')] });
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 5 }));
    await AiGateway.execute(req({ maxOutputTokensCap: 3000 }));
    expect(traces()).toHaveLength(1);
    const c = cap(0);
    expect(c).toMatchObject({ origin: 'gateway', callKind: 'analysis', callIndex: 0, sourceIds: [42] });
    // Prompt FINAL réellement transmis (jamais reconstitué) : identique à l'appel fournisseur.
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].prompt).toBe(fake.calls[0].prompt);
    expect(c.sent[0].generationConfig).toMatchObject({ model: 'm-a', temperature: 0, maxOutputTokens: 3000, responseMimeType: 'application/json', attachments: 1 });
    // Variables résolues APRÈS masquage, masques relevés.
    expect(JSON.stringify(c.variables)).not.toMatch(/3000 6000/);
    expect(c.variableMasks).toEqual({ '[IBAN_MASQUE]': 1 });
    expect(c.attachments).toHaveLength(1);
    // Plafond : demandé (configuration), adapté (plafond de l'appelant), envoyé.
    expect(c.params).toMatchObject({ model: 'm-a', rank: 'primary', maxOutputTokens: { requested: 4000, callerCap: 3000, adapted: 3000, sent: 3000, inherited: null } });
    expect(c.responseRaw).toBe(t1Out({ ok: true }));
    expect(c.parsed).toEqual({ firstPass: { task: 'GROUP_UPLOAD', ok: true }, accepted: { task: 'GROUP_UPLOAD', ok: true } });
    // La capture n'entre jamais dans les métadonnées du journal.
    expect(JSON.stringify({ ...traces()[0], capture: undefined })).not.toMatch(/IBAN_MASQUE/);
  });

  it('L82C-CAP-02 — échec puis repli : tentative en échec capturée, repli hérité du plafond', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b')] });
    fake.on('m-a', () => { throw Object.assign(new Error('503 Service Unavailable'), { status: 503 }); });
    fake.on('m-b', () => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    expect(traces().map((t) => [t.model, t.status])).toEqual([['m-a', 'error'], ['m-b', 'success']]);
    expect(cap(0)).toMatchObject({ callKind: 'analysis', responseRaw: null, sent: [{ outcome: 'FAILED' }] });
    expect(cap(0).sent[0].error).toMatch(/503/);
    expect((cap(0).diagnostic as { family: string }).family).toBe('PROVIDER_ERROR');
    expect(cap(1).params).toMatchObject({ rank: 'fallback_1', maxOutputTokens: { requested: 4000, inherited: 4000, sent: 4000 } });
    expect(cap(1).sent[0].prompt).toBe(fake.calls[1].prompt);
  });

  it('L82C-CAP-03 — réparation ciblée : capture distincte, sortie d’origine erronée conservée', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', null)] });
    fake.onAny((input) => (input.callKind === 'repair'
      ? { rawText: t1Out({ ok: true }), inputTokens: 5, outputTokens: 5 }
      : { rawText: t1Out({ ok: 'peut-être' }), inputTokens: 10, outputTokens: 5 }));
    await AiGateway.execute(req());
    expect(traces().map((t) => t.callKind)).toEqual(['analysis', 'repair']);
    expect(cap(0).responseRaw).toBe(t1Out({ ok: 'peut-être' }));
    expect(cap(0).parsed).toMatchObject({ firstPass: { ok: 'peut-être' } });
    expect(cap(1)).toMatchObject({ callKind: 'repair', attachments: [], responseRaw: t1Out({ ok: true }) });
    expect(cap(1).sent).toHaveLength(1);
    expect(cap(1).sent[0]).toMatchObject({ kind: 'repair' });
    expect(cap(1).sent[0].prompt).toBe(fake.calls[1].prompt);
  });

  it('L82C-CAP-04 — essais internes du même modèle : les deux prompts transmis sont capturés', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', null)] });
    fake.onAny((input) => {
      if (input.responseSchema) throw invalidArgument('Invalid JSON payload received. response_schema too many states');
      return { rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 };
    });
    await AiGateway.execute(req());
    const steps = cap(0).sent;
    expect(steps.map((s) => [s.kind, s.outcome])).toEqual([['initial', 'FAILED'], ['schema_rejected_retry', 'SUCCESS']]);
    expect(steps[0].prompt).toBe(fake.calls[0].prompt);
    expect(steps[1].prompt).toBe(fake.calls[1].prompt);
    expect(steps[0].generationConfig?.responseJsonSchema).toMatchObject({ sent: true });
    expect(steps[1].generationConfig?.responseJsonSchema).toBeUndefined();
  });

  it('L82C-CAP-05 — refus avant appel : capture sans envoi, motif dans le diagnostic', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', null)] });
    fake.onAny(() => ({ rawText: '{}', inputTokens: 0, outputTokens: 0 }));
    // Schéma d'appelant ≠ contrat du registre : RUNTIME_CONTRACT_MISMATCH avant tout appel.
    await expect(AiGateway.execute(req({ outputSchema: z.object({ autre: z.string() }) }))).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
    expect(cap(0)).toMatchObject({ callKind: 'pre_call_refusal', sent: [], responseRaw: null, attemptDurationMs: 0 });
    expect(traces()[0].durationMs).toBe(0);
  });

  it('L82C-CAP-06 — T2 : réponse capturée (décision PO 01) et rattachée à sa conversation', async () => {
    fake.onAny(() => ({ rawText: '{"mode":"ANSWER","ok":true}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute({
      useCaseCode: 'INTELLIGENT_ASSISTANT' as never, operationCode: 't2_answer', accountId: 1, userId: 2,
      promptVariables: t2MasterVariables('ANSWER', { QUESTION: 'Quand vidanger ?' }),
      outputSchema: asTestContract(z.object({ mode: z.literal('ANSWER'), ok: z.boolean() })),
      idempotencyKey: `assistant:c55:${Math.random()}`, maxModelAttempts: 1,
    });
    const t = traces()[0];
    expect(String(t.outputPreview)).toMatch(/^sha256:/); // journal inchangé (§29.6)
    expect(t.capture).toMatchObject({ subjectRef: 't2-conversation:55', responseRaw: '{"mode":"ANSWER","ok":true}' });
    expect(t.capture?.sent[0].prompt).toContain('Quand vidanger ?');
  });
});

describe('L82C-DUR — durée propre par tentative et durée murale', () => {
  it('L82C-DUR-01 — le repli ne compte plus la durée du modèle précédent', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b')] });
    fake.on('m-a', async () => { await new Promise((r) => setTimeout(r, 60)); throw Object.assign(new Error('503'), { status: 503 }); });
    fake.on('m-b', () => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    const res = await AiGateway.execute(req());
    const [a, b] = traces();
    expect(a.durationMs).toBeGreaterThanOrEqual(55);
    // Avant : durée de b = cumul depuis le début (≥ 60 ms). Désormais : durée propre.
    expect(b.durationMs).toBeLessThan(40);
    expect(b.executionElapsedMs).toBeGreaterThanOrEqual(55);
    expect(a.durationMs + b.durationMs).toBeLessThanOrEqual(res.durationMs + 5);
    expect(cap(1).attemptDurationMs).toBe(b.durationMs);
  });
});

describe('L82C-PAR — paramètre refusé (LOG-04, R02, incident 4694)', () => {
  it('L82C-PAR-01 — classification : PARAMETER_REJECTED et paramètre concerné', () => {
    const c = classifyCallError(invalidArgument("Invalid JSON payload received. Unknown name \\\"thinkingLevel\\\" at 'generation_config.thinking_config': Cannot find field."));
    expect(c).toMatchObject({ family: 'INPUT_ERROR', subtype: 'PARAMETER_REJECTED', stage: 'provider_request', rejectedParameter: 'generationConfig.thinkingConfig.thinkingLevel' });
    expect(isGenericInvalidArgument(c)).toBe(false);
    expect(providerFailureCategory(c.family, c.subtype)).toBe('PARAMETER_REJECTED');
    expect(displayCause(c.family, c.subtype)).toBe('INPUT_ERROR / PARAMETER_REJECTED');
    expect(rejectedParameterOf('Budget 0 is invalid. This model only works in thinking mode.')).toBe('generationConfig.thinkingConfig.thinkingBudget');
    expect(rejectedParameterOf('Thinking level is not supported for this model.')).toBe('generationConfig.thinkingConfig.thinkingLevel');
    expect(rejectedParameterOf("Invalid value at 'generation_config.max_output_tokens' (TYPE_INT32)")).toBe('generationConfig.maxOutputTokens');
    // Refus générique et refus du schéma : inchangés.
    expect(rejectedParameterOf('Request contains an invalid argument.')).toBeNull();
    expect(rejectedParameterOf('response_schema: too many states')).toBeNull();
    expect(classifyCallError(invalidArgument('Request contains an invalid argument.')).subtype).toBeNull();
  });

  it('L82C-PAR-02 — passerelle : requête refusée (jamais indisponibilité), paramètre tracé, aucun essai sans schéma inutile', async () => {
    __setConfigForTests({ versionId: 1, entries: [t1('m-a', 'm-b')] });
    fake.on('m-a', () => { throw invalidArgument('Thinking level is not supported for this model.'); });
    fake.on('m-b', () => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    const a = traces()[0];
    expect(a.errorCode).toBe('PROVIDER_REQUEST_REJECTED');
    expect(a.failure).toMatchObject({ family: 'INPUT_ERROR', subtype: 'PARAMETER_REJECTED', parameter: 'generationConfig.thinkingConfig.thinkingLevel' });
    expect(fake.calls.filter((c) => c.model === 'm-a')).toHaveLength(1);
    expect((cap(0).diagnostic as { provider: { rejectedParameter: string } }).provider.rejectedParameter).toBe('generationConfig.thinkingConfig.thinkingLevel');
  });
});
