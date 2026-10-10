/**
 * §15.11, §31.3 — le modèle ATTENDU tracé avec chaque appel vient de la
 * chaîne EFFECTIVE (version de configuration du BO), pas de la configuration
 * statique : après un changement de modèle dans le BO, l'alerte « modèle
 * résolu ≠ attendu » ne se déclenche pas à tort.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { fakeProvider } from '@/test/setup';

const h = vi.hoisted(() => ({ unsafe: vi.fn(async (_sql: string, _p?: unknown[]) => [] as unknown[]) }));
vi.mock('@/db', () => ({ pgClient: { unsafe: h.unsafe }, db: {}, ensureMigrations: vi.fn(async () => {}) }));
vi.mock('@/services/ai/config/config-resolver', async (orig) => {
  const vrai = await orig<typeof import('@/services/ai/config/config-resolver')>();
  return {
    ...vrai,
    // Version active du BO : modèles différents de ceux du code.
    resolveOperationConfig: vi.fn(async (op: string) => ({
      ...(await vrai.resolveOperationConfig(op)),
      primaryModel: 'gemini-bo-principal', fallbackModels: ['gemini-bo-repli'], configVersionId: 12,
    })),
  };
});

const { executeWithinBudget, createAiCallBudget } = await import('../ai-call-budget');
const { awaitAiRuns } = await import('../usage-tracking.service');
const { aliasForRank } = await import('../../registries/model-registry');

beforeEach(() => {
  h.unsafe.mockReset();
  h.unsafe.mockImplementation(async () => []);
  process.env.VEREBONA_ASSISTANT_MODEL_ASSISTANT_DEFAULT = 'gemini-statique';
});

afterEach(() => { delete process.env.VEREBONA_ASSISTANT_MODEL_ASSISTANT_DEFAULT; });

describe('modèle attendu = chaîne effective', () => {
  it('aliasForRank : la chaîne résolue prime sur la configuration statique', () => {
    const chaine = { operationCode: 't2_answer', default: 'gemini-bo-principal', escalation: 'gemini-bo-repli' };
    expect(aliasForRank(0, 't2_answer', chaine).expectedModel).toBe('gemini-bo-principal');
    expect(aliasForRank(1, 't2_answer', chaine).expectedModel).toBe('gemini-bo-repli');
    expect(aliasForRank(0, 't2_answer').expectedModel).toBe('gemini-statique');
  });

  it('l’appel réel trace le modèle de la version BO comme attendu : aucun écart', async () => {
    fakeProvider.onAny(() => ({ rawText: '{"mode":"ANSWER","format":"claims","status":"answered","claims":[]}', inputTokens: 1, outputTokens: 1 }));
    const { t2MasterVariables } = await import('@/services/ai/assistant/master/t2-answer');
    const { asTestContract } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    await executeWithinBudget(createAiCallBudget(2), {
      useCaseCode: 'INTELLIGENT_ASSISTANT', operationCode: 't2_answer', accountId: 1,
      promptVariables: t2MasterVariables('ANSWER', { QUESTION: 'q', INTENT: 'ACCOUNT_SUMMARY' }), outputSchema: asTestContract(z.object({ mode: z.literal('ANSWER') }).passthrough()), idempotencyKey: `k-${Math.random()}`,
    }, { requestId: 'req-bo', routeReason: 'x', promptId: 'p', promptVersion: 'v' });
    await awaitAiRuns('req-bo');
    const insertion = h.unsafe.mock.calls.find(([sql]) => /INSERT INTO verebona_ai_runs/.test(String(sql)))!;
    const params = insertion[1] as unknown[];
    expect(params[4]).toBe('gemini-bo-principal');      // modèle réellement appelé
    expect(params.at(-1)).toBe('gemini-bo-principal');  // modèle attendu
  });
});
