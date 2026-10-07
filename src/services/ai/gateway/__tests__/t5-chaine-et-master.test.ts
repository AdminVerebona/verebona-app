/**
 * Lot 32B — T5 (Prompt Control) à l'exécution, par la passerelle réelle
 * (fournisseur simulé) :
 *   · PO 26 : principal / repli 1 / repli 2 de T5 réglés au BO (version de
 *     configuration) et RÉELLEMENT utilisés — repli sollicité sur échec du
 *     principal, dans l'ordre ;
 *   · PO 15 : le texte de la version ACTIVE « Prompts maîtres » de T5 est
 *     celui envoyé au modèle ; un texte T5 porté par une version de
 *     configuration ne l'est jamais.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const { __setActiveMasterPromptsForTests } = await import('../../master-prompts/master-prompt-runtime');
const { T5AnalyzeOutput } = await import('../../governance/master/t5-contract');
const { readMasterFileFromRepo } = await import('../../governance/master-corpus/cases');

const ANALYZE_OK = JSON.stringify({ mode: 'ANALYZE', verdict: 'code', analysis: 'Cause dans le code.', targets: [] });

let fake: InstanceType<typeof FakeProvider>;
const req = () => ({
  useCaseCode: 'AI_GOVERNANCE' as const,
  operationCode: 't5_analyze',
  accountId: 1,
  promptVariables: { CURRENT_MASTER_PROMPTS: '(aucun)', INSTRUCTION: 'Pourquoi ce document n’est-il pas classé ?' },
  outputSchema: T5AnalyzeOutput as z.ZodType<unknown>,
  idempotencyKey: `t5-${Math.random()}`,
});
const T5 = (over: Record<string, unknown> = {}) => ({
  ...emptyTreatmentConfig('T5'), primaryModel: 'm-principal', fallback1: 'm-repli-1', fallback2: 'm-repli-2', maxOutputTokens: 8000, ...over,
});

beforeEach(() => {
  traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
});
afterEach(() => { __setConfigForTests(null); __setActiveMasterPromptsForTests(null); });

describe('PO26 — chaîne de secours T5 paramétrée au BO et utilisée à l’exécution', () => {
  it('PO26-01 — principal en échec : repli 1 sollicité ; principal et repli 1 en échec : repli 2', async () => {
    __setConfigForTests({ versionId: 21, entries: [T5()] });
    fake.on('m-principal', () => { throw new Error('503 indisponible'); });
    fake.on('m-repli-1', () => ({ rawText: ANALYZE_OK, inputTokens: 1, outputTokens: 1 }));
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('m-repli-1');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-principal', 'm-repli-1']);

    fake.calls.length = 0;
    fake.on('m-repli-1', () => { throw new Error('404 modèle retiré'); });
    fake.on('m-repli-2', () => ({ rawText: ANALYZE_OK, inputTokens: 1, outputTokens: 1 }));
    const r2 = await AiGateway.execute(req());
    expect(r2.model).toBe('m-repli-2');
    expect(fake.calls.map((c) => c.model)).toEqual(['m-principal', 'm-repli-1', 'm-repli-2']);
  });

  it('PO26-02 — sans repli réglé : aucun modèle de secours inventé (la chaîne est celle du BO)', async () => {
    __setConfigForTests({ versionId: 22, entries: [T5({ fallback1: null, fallback2: null })] });
    fake.on('m-principal', () => { throw new Error('503'); });
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });
    expect(fake.calls.map((c) => c.model)).toEqual(['m-principal']);
  });
});

describe('PO15 — texte du prompt maître T5 administré au BO', () => {
  it('PO15-08 — version active du BO envoyée au modèle ; texte de configuration T5 jamais appliqué', async () => {
    const fichier = readMasterFileFromRepo('t5_master_v1');
    __setConfigForTests({ versionId: 23, entries: [T5({ masterPrompt: 'TEXTE CONFIG T5 IGNORÉ', promptArchitecture: 'master' })] });
    fake.onAny(() => ({ rawText: ANALYZE_OK, inputTokens: 1, outputTokens: 1 }));

    await AiGateway.execute(req());
    expect(fake.calls[0].prompt).not.toContain('TEXTE CONFIG T5 IGNORÉ');
    expect(traces.at(-1)?.masterPromptVersion).toBe('t5_master_v1@file');

    __setActiveMasterPromptsForTests([{ id: 77, treatment: 'T5', versionNumber: 3, content: `${fichier}\n\nR9 — CONSIGNE T5 ACTIVÉE AU BO.` }]);
    await AiGateway.execute(req());
    expect(fake.calls.at(-1)?.prompt).toContain('R9 — CONSIGNE T5 ACTIVÉE AU BO.');
    expect(String(traces.at(-1)?.masterPromptVersion)).toMatch(/^t5_master_v1@pv77:[0-9a-f]{12}$/);
  });
});
