/**
 * CDC Assistant §29.6 — « Ne pas stocker par défaut : réponse brute non
 * validée ». Pour l'assistant, la trace d'appel ne garde de la sortie du
 * modèle qu'une empreinte et une longueur ; l'extrait cité par une erreur de
 * validation est retiré. Les autres usages gardent leur extrait expurgé.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../../telemetry/ai-trace.service', () => ({
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push(t); }),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => {
  h.traces.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
  delete process.env.VEREBONA_ASSISTANT_DIAGNOSTIC_PREVIEW;
});

const { t2MasterVariables } = await import('../../assistant/master/t2-answer');
const { asTestContract } = await import('../output-resolution/runtime-contract');

const req = (useCaseCode: string, operationCode: string, schema: z.ZodType<unknown>) => ({
  useCaseCode: useCaseCode as never, operationCode, accountId: 1,
  // Lot 16b-2 : l'assistant n'a plus que son master T2 (variables déclarées).
  promptVariables: operationCode.startsWith('t2_') ? t2MasterVariables('ANSWER', { QUESTION: 'q' }) : { QUESTION: 'q' },
  // Lot 34D : schéma de test déclaré contrat de test (sinon RUNTIME_CONTRACT_MISMATCH).
  outputSchema: asTestContract(schema), idempotencyKey: `k-${Math.random()}`, maxModelAttempts: 1,
});

describe('trace d’un appel de l’assistant', () => {
  it('succès : empreinte et longueur, jamais le texte', async () => {
    fake.onAny(() => ({ rawText: '{"mode":"ANSWER","ok":true,"secret":"IBAN FR76"}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req('INTELLIGENT_ASSISTANT', 't2_answer', z.object({ mode: z.literal('ANSWER'), ok: z.boolean() }).passthrough()));
    const t = h.traces.at(-1)!;
    expect(String(t.outputPreview)).toMatch(/^sha256:[0-9a-f]{12} len:\d+$/);
    expect(JSON.stringify(t)).not.toMatch(/IBAN|secret/);
  });

  it('sortie invalide : message d’erreur sans l’extrait brut', async () => {
    fake.onAny(() => ({ rawText: 'pas du json IBAN FR76', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req('INTELLIGENT_ASSISTANT', 't2_answer', z.object({ mode: z.literal('ANSWER'), ok: z.boolean() }))).catch(() => null);
    const t = h.traces.at(-1)!;
    expect(t.status).toBe('error');
    expect(String(t.errorMessage)).toMatch(/\[extrait non conservé\]/);
    expect(JSON.stringify(t)).not.toMatch(/IBAN/);
  });

  it('diagnostic explicite (flag) : extrait expurgé, comme les autres usages', async () => {
    process.env.VEREBONA_ASSISTANT_DIAGNOSTIC_PREVIEW = 'on';
    fake.onAny(() => ({ rawText: '{"mode":"ANSWER","ok":true}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req('INTELLIGENT_ASSISTANT', 't2_answer', z.object({ mode: z.literal('ANSWER'), ok: z.boolean() })));
    expect(h.traces.at(-1)!.outputPreview).toBe('{"mode":"ANSWER","ok":true}');
  });

  it('les autres usages gardent leur extrait expurgé', async () => {
    // Lot 16b-3 : opération T1 réelle (branche GROUP_UPLOAD du master).
    const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');
    const sortie = t1Out({ title: 'Facture', amountCents: 1 });
    fake.onAny(() => ({ rawText: sortie, inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute({
      ...req('SOURCE_ANALYSIS', T1_TEST_OPERATION, t1Schema({ title: z.string(), amountCents: z.number() })),
      promptVariables: t1TestVariables(),
    });
    expect(h.traces.at(-1)!.outputPreview).toBe(sortie);
  });
});
