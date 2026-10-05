/**
 * Revue lot 12 — la clé d'idempotence d'une opération master inclut la
 * version résolue du master (`@file` ou `@cfg<id>:<empreinte>`) : un nouveau
 * master ne sert jamais une sortie mise en cache sous l'ancien.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { join } from 'path';

const keys: string[] = [];
vi.mock('../../idempotency/idempotency.service', async (orig) => ({
  ...(await orig<typeof import('../../idempotency/idempotency.service')>()),
  withIdempotency: async (key: string, fn: () => Promise<unknown>) => { keys.push(key); return fn(); },
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async () => {},
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setPromptsRootForTests } = await import('../../prompts/prompt-loader');
const { T1GroupUploadOutput } = await import('../../source-analysis/master/t1-contract');

const FIXTURES = join(__dirname, '..', '..', 'prompts', '__tests__', 'fixtures', 'masters');
const VARS = { SOURCES: '[]', EXTRACTED_CONTENT: '', FIELD_CATALOG: null };
const master = (n: number) => `MASTER ${n} {{TASK}} {{SOURCES}} {{EXTRACTED_CONTENT}} {{FIELD_CATALOG}}\n`
  + 'BRANCHE TASK = GROUP_UPLOAD\nBRANCHE TASK = ANALYZE_DOCUMENT';
const version = (masterPrompt: string | null, architecture: 'steps' | 'master' = 'master') => __setConfigForTests({
  versionId: 21,
  entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', masterPrompt, promptArchitecture: architecture }],
});
const call = (over: Record<string, unknown> = {}) => AiGateway.execute({
  useCaseCode: 'SOURCE_ANALYSIS', operationCode: 't1_group_upload', accountId: 1,
  promptVariables: VARS, outputSchema: T1GroupUploadOutput, sourceIds: [1], ...over,
});

beforeEach(() => {
  keys.length = 0;
  const fake = new FakeProvider();
  fake.onAny(() => ({ rawText: '{"task":"GROUP_UPLOAD","groups":[[0]]}', inputTokens: 1, outputTokens: 1 }));
  setAiProvider(fake);
  __setPromptsRootForTests(FIXTURES);
});
afterEach(() => __setConfigForTests(null));
afterAll(() => __setPromptsRootForTests(null));

describe('idempotence des opérations master', () => {
  it('clé dérivée : change avec le texte master de la version, stable à texte égal', async () => {
    version(master(1)); await call();
    version(master(1)); await call();
    version(master(2)); await call();
    version(null); await call(); // fichier
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });

  it('lot 16b-3 : ligne T1 stockée « steps » lue master — même clé qu’en master', async () => {
    version(master(3), 'master'); await call();
    version(master(3), 'steps'); await call();
    version(null); await call();
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('clé fournie par l’appelant : suffixée par la version du master', async () => {
    version(master(1)); await call({ idempotencyKey: 'k-appelant' });
    version(null); await call({ idempotencyKey: 'k-appelant' });
    expect(keys[0]).toMatch(/^k-appelant:t1_master_v1@cfg21:[0-9a-f]{12}$/);
    expect(keys[1]).toBe('k-appelant:t1_master_v1@file');
  });
});

describe('idempotence T3 master (lot 13)', () => {
  it('la clé suit la version du master T3 (fichier puis texte de version)', async () => {
    __setPromptsRootForTests(null);
    const { T3LinkAmbiguityOutput } = await import('../../reconciliation/master/t3-contract');
    const fake = new FakeProvider();
    fake.onAny(() => ({ rawText: '{"task":"LINK_AMBIGUITY","matches":[]}', inputTokens: 1, outputTokens: 1 }));
    setAiProvider(fake);
    const vars = { FIELD: null, CURRENT_STATE: null, EVIDENCES: null, SUBJECT_CONTEXT: 's', CANDIDATES: [], RELATION_TYPE: 'r' };
    const t3 = (masterPrompt: string | null) => __setConfigForTests({
      versionId: 33, entries: [{ ...emptyTreatmentConfig('T3'), primaryModel: 'm-a', masterPrompt, promptArchitecture: 'master' }],
    });
    const run = () => AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION', operationCode: 't3_link_ambiguity', accountId: 1,
      promptVariables: vars, outputSchema: T3LinkAmbiguityOutput, idempotencyKey: 'k-t3',
    });
    t3(null); await run();
    const master = '{{TASK}} {{FIELD}} {{CURRENT_STATE}} {{EVIDENCES}} {{SUBJECT_CONTEXT}} {{CANDIDATES}} {{RELATION_TYPE}}\n'
      + 'BRANCHE TASK = VALUE_CONFLICT\nBRANCHE TASK = LINK_AMBIGUITY';
    t3(master); await run();
    expect(keys[0]).toBe('k-t3:t3_master_v1@file');
    expect(keys[1]).toMatch(/^k-t3:t3_master_v1@cfg33:[0-9a-f]{12}$/);
  });
});
