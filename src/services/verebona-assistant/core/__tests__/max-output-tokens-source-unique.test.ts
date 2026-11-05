/**
 * CDC 15 T2-43 — `maxOutputTokens` de l'assistant : la valeur vient de la
 * configuration IA effective (`t2_answer`, master T2 seul depuis le lot
 * 16b-2). Lot 111M (arbitrage PO, ticket « budgets IA », CA-01/CA-11) :
 * plus de borne parallèle à 500 — la valeur BO est transmise telle quelle,
 * bornée seulement par la limite déclarée du modèle. L'ancienne variable
 * `VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS` est IGNORÉE (lot 15 : source
 * unique), seulement signalée une fois.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { fakeProvider } from '@/test/setup';
import { __setConfigForTests, resolveOperationConfig } from '@/services/ai/config/config-resolver';
import { emptyTreatmentConfig } from '@/services/ai/config/config-types';
import { ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS, getOperation } from '@/services/ai/registry/operations';
import { executeWithinBudget } from '../ai-call-budget';
import { t2MasterVariables } from '@/services/ai/assistant/master/t2-answer';
import { asTestContract } from '@/services/ai/gateway/output-resolution/runtime-contract';
import {
  getAssistantConfig, signalRetiredOutputTokensVariable, __resetOutputTokensWarningForTests,
} from '../../config/assistant-config';

vi.mock('@/services/ai/telemetry/ai-trace.service', () => ({ recordCallTrace: async () => undefined }));

const req = () => ({
  useCaseCode: 'INTELLIGENT_ASSISTANT' as const,
  operationCode: 't2_answer',
  accountId: 1,
  promptVariables: t2MasterVariables('ANSWER', { QUESTION: 'q', INTENT: 'ACCOUNT_FACT_ASSET' }),
  // Lot 34D : schéma de test déclaré contrat de test (sinon RUNTIME_CONTRACT_MISMATCH).
  outputSchema: asTestContract(z.object({ mode: z.literal('ANSWER') }).passthrough()),
  idempotencyKey: `k-${Math.random()}`,
});

const OK = '{"mode":"ANSWER","format":"claims","status":"answered","claims":[]}';

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
    fakeProvider.on('m-a', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req());
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(300);
  });

  it('L111M — version BO > 500 : transmise telle quelle (plus de plafond caché)', async () => {
    version(800);
    fakeProvider.on('m-a', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req());
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(800);
    // La configuration effective, elle, reste celle du BO (une seule source).
    expect((await resolveOperationConfig('t2_answer')).maxOutputTokens).toBe(800);
  });

  it('aucune version : valeur initiale du code (réponse : 2 048, limite haute de sécurité)', async () => {
    fakeProvider.on(getOperation('t2_answer').primaryModel, () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req());
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS);
    expect(ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS).toBe(2_048);
  });

  it('variable retirée encore posée : ignorée (source unique), signalée une fois', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS = '200';
    version(400);
    fakeProvider.on('m-a', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req());
    await executeWithinBudget(undefined, req());
    // Seule la configuration BO (400) s'applique — la variable n'abaisse plus rien.
    expect(fakeProvider.calls.map((c) => c.maxOutputTokens)).toEqual([400, 400]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS'))).toHaveLength(1);
    // Ni pour relever le budget : la fonction ne fait que signaler.
    expect(signalRetiredOutputTokensVariable({ VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS: '2000' } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('la configuration de l’assistant ne porte plus de plafond parallèle', () => {
    expect('maxOutputTokens' in getAssistantConfig()).toBe(false);
  });

  it('un plafond explicite d’appel ne peut que réduire', async () => {
    version(450);
    fakeProvider.on('m-a', () => ({ rawText: OK, inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(undefined, req(), undefined, { maxOutputTokens: 300 });
    expect(fakeProvider.calls[0].maxOutputTokens).toBe(300);
  });
});
