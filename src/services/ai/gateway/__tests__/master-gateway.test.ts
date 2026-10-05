/**
 * CDC 15 §22.2, §22.3, §29.1, D-03, D-04, D-06, DP-05, ARCH-03 — la gateway
 * sur une opération master : master chargé (fichier ou version), TASK imposée
 * et tracée, aucun préambule concaténé, sortie discriminée par `task`.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { join } from 'path';
import { z } from 'zod';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setPromptsRootForTests } = await import('../../prompts/prompt-loader');
const { AiOutputTaskMismatchError } = await import('../errors');
const { T1GroupUploadOutput, T1MasterOutput, T1AnalyzeDocumentOutput } =
  await import('../../source-analysis/master/t1-contract');

const FIXTURES = join(__dirname, '..', '..', 'prompts', '__tests__', 'fixtures', 'masters');
const VARS = { SOURCES: '[{"index":0,"name":"a.pdf"}]', EXTRACTED_CONTENT: '', FIELD_CATALOG: null };
const GROUP_OK = JSON.stringify({ task: 'GROUP_UPLOAD', groups: [[0]] });
const ANALYZE_OK = JSON.stringify({ task: 'ANALYZE_DOCUMENT' });

let fake: InstanceType<typeof FakeProvider>;

const groupReq = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const,
  operationCode: 't1_group_upload',
  accountId: 1,
  promptVariables: VARS,
  outputSchema: T1GroupUploadOutput as z.ZodType<unknown>,
  idempotencyKey: `k-${Math.random()}`,
  ...over,
});

const T1 = (over: Record<string, unknown> = {}) => ({
  ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: 'm-b', fallback2: null, ...over,
});

beforeEach(() => {
  traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  __setPromptsRootForTests(FIXTURES);
});
afterEach(() => __setConfigForTests(null));
afterAll(() => __setPromptsRootForTests(null));

describe('opération master', () => {
  it('master du dépôt, TASK injectée et tracée automatiquement, sans préambule', async () => {
    __setConfigForTests({ versionId: 3, entries: [T1({ prompt: 'PRÉAMBULE STEPS' })] });
    fake.on('m-a', () => ({ rawText: GROUP_OK, inputTokens: 1, outputTokens: 1 }));

    const r = await AiGateway.execute(groupReq());
    expect(r.data).toEqual({ task: 'GROUP_UPLOAD', groups: [[0]] });
    expect(r.promptVersion).toBe('t1_master_v1@file');

    const envoye = fake.calls[0];
    expect(envoye.prompt).toContain('TASK courante : GROUP_UPLOAD');
    expect(envoye.prompt).not.toContain('PRÉAMBULE STEPS');
    expect(envoye.task).toBe('GROUP_UPLOAD');
    expect(traces[0]).toMatchObject({
      task: 'GROUP_UPLOAD', masterPromptCode: 't1_master_v1', masterPromptVersion: 't1_master_v1@file', engine: 'new',
    });
  });

  it('D-03/D-04 : architecture master → texte de la version, version tracée par empreinte', async () => {
    const texte = 'MASTER DE LA VERSION {{TASK}} {{SOURCES}} {{EXTRACTED_CONTENT}} {{FIELD_CATALOG}}\n'
      + 'BRANCHE TASK = GROUP_UPLOAD\nBRANCHE TASK = ANALYZE_DOCUMENT';
    __setConfigForTests({ versionId: 8, entries: [T1({ prompt: 'PRÉAMBULE ÉTAPES', masterPrompt: texte, promptArchitecture: 'master' })] });
    fake.on('m-a', () => ({ rawText: GROUP_OK, inputTokens: 1, outputTokens: 1 }));

    await AiGateway.execute(groupReq());
    expect(fake.calls[0].prompt.startsWith('MASTER DE LA VERSION GROUP_UPLOAD')).toBe(true);
    expect(fake.calls[0].prompt).not.toContain('PRÉAMBULE ÉTAPES');
    expect(traces[0].masterPromptVersion).toMatch(/^t1_master_v1@cfg8:[0-9a-f]{12}$/);
    expect(traces[0].promptVersion).toBe(traces[0].masterPromptVersion);
  });

  it('lot 16b-3 : ligne T1 stockée « steps » (antérieure à 0233) lue master — texte de la version appliqué, préambule jamais', async () => {
    const texte = 'MASTER PRÉPARÉ {{TASK}} {{SOURCES}} {{EXTRACTED_CONTENT}} {{FIELD_CATALOG}}\n'
      + 'BRANCHE TASK = GROUP_UPLOAD\nBRANCHE TASK = ANALYZE_DOCUMENT';
    __setConfigForTests({ versionId: 9, entries: [T1({ prompt: 'PRÉAMBULE', masterPrompt: texte, promptArchitecture: 'steps' })] });
    fake.on('m-a', () => ({ rawText: GROUP_OK, inputTokens: 1, outputTokens: 1 }));
    const r = await AiGateway.execute(groupReq());
    expect(r.promptVersion).toMatch(/^t1_master_v1@cfg9:/);
    expect(fake.calls[0].prompt).toContain('MASTER PRÉPARÉ');
    expect(fake.calls[0].prompt).not.toContain('PRÉAMBULE');
  });

  it('refuse une requête dont la TASK ou le master contredit l’opération, sans appel', async () => {
    fake.onAny(() => ({ rawText: GROUP_OK, inputTokens: 1, outputTokens: 1 }));
    await expect(AiGateway.execute(groupReq({ task: 'ANALYZE_DOCUMENT' })))
      .rejects.toMatchObject({ code: 'TASK_MISMATCH', recoverable: false });
    await expect(AiGateway.execute(groupReq({ masterPromptCode: 't2_master_v1' })))
      .rejects.toMatchObject({ code: 'TASK_MISMATCH' });
    // Même TASK : accepté.
    await expect(AiGateway.execute(groupReq({ task: 'GROUP_UPLOAD' }))).resolves.toBeTruthy();
    expect(fake.calls).toHaveLength(1);
  });

  it('master inutilisable (variable non déclarée) : MASTER_PROMPT_INVALID, aucun appel', async () => {
    fake.onAny(() => ({ rawText: GROUP_OK, inputTokens: 1, outputTokens: 1 }));
    await expect(AiGateway.execute(groupReq({ promptVariables: { ...VARS, CONSIGNE_CACHEE: 'x' } })))
      .rejects.toMatchObject({ code: 'MASTER_PROMPT_INVALID', recoverable: false });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('validation discriminée par task', () => {
  it('sortie d’une autre branche : erreur de validation récupérable, repli sur le modèle suivant', async () => {
    __setConfigForTests({ versionId: 4, entries: [T1()] });
    fake.on('m-a', () => ({ rawText: ANALYZE_OK, inputTokens: 5, outputTokens: 5 }));
    fake.on('m-b', () => ({ rawText: GROUP_OK, inputTokens: 1, outputTokens: 1 }));

    // Union complète : accepterait ANALYZE_DOCUMENT sans le contrôle de TASK.
    const r = await AiGateway.execute(groupReq({ outputSchema: T1MasterOutput }));
    expect(r.model).toBe('m-b');
    expect(traces[0]).toMatchObject({ status: 'error', errorCode: 'INVALID_OUTPUT', task: 'GROUP_UPLOAD' });
    expect(String(traces[0].errorMessage)).toMatch(/ANALYZE_DOCUMENT.*TASK=GROUP_UPLOAD/);
  });

  it('toutes les sorties dans la mauvaise branche : ALL_MODELS_FAILED, dernier échec INVALID_OUTPUT', async () => {
    __setConfigForTests({ versionId: 4, entries: [T1()] });
    fake.onAny(() => ({ rawText: ANALYZE_OK, inputTokens: 1, outputTokens: 1 }));
    await expect(AiGateway.execute(groupReq({ outputSchema: T1MasterOutput })))
      .rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' });
    expect(fake.calls).toHaveLength(2);
    expect(AiOutputTaskMismatchError.name).toBe('AiOutputTaskMismatchError');
  });

  it('D-06 : ANALYZE_DOCUMENT garde un plancher de 32 768 jetons de sortie malgré le plafond T1', async () => {
    __setConfigForTests({ versionId: 5, entries: [T1({ maxOutputTokens: 4096 })] });
    fake.on('m-a', () => ({ rawText: ANALYZE_OK, inputTokens: 1, outputTokens: 1 }));
    const r = await AiGateway.execute(groupReq({
      operationCode: 't1_analyze_document', outputSchema: T1AnalyzeDocumentOutput,
    }));
    expect((r.data as { task: string }).task).toBe('ANALYZE_DOCUMENT');
    expect(fake.calls[0].maxOutputTokens).toBe(32_768);
    expect(fake.calls[0].timeoutMs).toBe(120_000);
    expect(traces[0]).toMatchObject({ task: 'ANALYZE_DOCUMENT', maxOutputTokens: 32_768 });
  });
});

describe('plus aucune opération par étapes (lot 16b-3)', () => {
  it('une ancienne étape T3 (resolve_ambiguity) est une opération inconnue : refusée avant tout appel', async () => {
    __setConfigForTests({ versionId: 6, entries: [{ ...emptyTreatmentConfig('T3'), primaryModel: 'm-a', fallback1: null, fallback2: null, prompt: 'PRÉAMBULE STEPS' }] });
    fake.onAny(() => ({ rawText: '{"x":1}', inputTokens: 1, outputTokens: 1 }));
    await expect(AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION', operationCode: 'resolve_ambiguity', accountId: 1,
      promptVariables: { FIELD: 'f' }, outputSchema: z.unknown(), idempotencyKey: `k-${Math.random()}`,
    })).rejects.toThrow(/Opération inconnue « resolve_ambiguity »/);
    expect(fake.calls).toHaveLength(0);
  });
});
