/**
 * CDC 15 T2-43 — `maxOutputTokens` de l'assistant : la valeur vient de la
 * configuration IA effective (`generate_answer`), bornée au budget V1 (500,
 * §31.2) tant que le PO n'a pas arbitré. L'ancienne variable
 * `VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS` n'est plus qu'un plafond inférieur
 * de compatibilité, signalé une fois.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { fakeProvider } from '@/test/setup';
import { __setConfigForTests, resolveOperationConfig } from '@/services/ai/config/config-resolver';
import { emptyTreatmentConfig } from '@/services/ai/config/config-types';
import { ASSISTANT_MAX_OUTPUT_TOKENS, getOperation } from '@/services/ai/registry/operations';
import { executeWithinBudget } from '../ai-call-budget';
import {
  getAssistantConfig, assistantMaxOutputTokensCap, __resetOutputTokensWarningForTests,
} from '../../config/assistant-config';

vi.mock('@/services/ai/telemetry/ai-trace.service', () => ({ recordCallTrace: async () => undefined }));

const req = () => ({
  useCaseCode: 'INTELLIGENT_ASSISTANT' as const,
  operationCode: 'generate_answer',
  accountId: 1,
  promptVariables: { QUESTION: 'q' },
  outputSchema: z.object({ ok: z.boolean() }),
  idempotencyKey: `k-${Math.random()}`,
});

const version = (maxOutputTokens: number) => __setConfigForTests({
  versionId: 7,
  entries: [{ ...emptyTreatmentConfig('T2'), primaryModel: 'm-a', maxOutputTokens }],
});

afterEach(() => {
  __setConfigForTests(null);
  delete process.env.VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS;
  __resetOutputTokensWarningForTests();
});

describe('T2-43 : plafond de sortie de l’assistant', () => {
  it('version BO ≤ 500 : sa valeur s’applique', async () => {
    version(300);
    fakeProvider.on('m-a', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req());
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(300);
  });

  it('version BO > 500 : plafonnée à 500 (budget V1, arbitrage PO en attente)', async () => {
    version(800);
    fakeProvider.on('m-a', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req());
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(500);
    // La configuration effective, elle, reste celle du BO (une seule source).
    expect((await resolveOperationConfig('generate_answer')).maxOutputTokens).toBe(800);
  });

  it('aucune version : valeur initiale du code (500)', async () => {
    fakeProvider.on(getOperation('generate_answer').primaryModel, () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req());
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(ASSISTANT_MAX_OUTPUT_TOKENS);
    expect(ASSISTANT_MAX_OUTPUT_TOKENS).toBe(500);
  });

  it('variable retirée encore posée : plafond inférieur seulement, signalée une fois', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS = '200';
    version(400);
    fakeProvider.on('m-a', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req());
    await executeWithinBudget(undefined, req());
    expect(fakeProvider.calls.map((c) => c.maxOutputTokens)).toEqual([200, 200]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS'))).toHaveLength(1);
    // Jamais pour relever le budget.
    expect(assistantMaxOutputTokensCap({ VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS: '2000' } as unknown as NodeJS.ProcessEnv)).toBe(500);
  });

  it('la configuration de l’assistant ne porte plus de plafond parallèle', () => {
    expect('maxOutputTokens' in getAssistantConfig()).toBe(false);
  });

  it('un plafond explicite d’appel ne peut que réduire', async () => {
    version(450);
    fakeProvider.on('m-a', () => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req(), undefined, { maxOutputTokens: 300 });
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(300);
  });
});
