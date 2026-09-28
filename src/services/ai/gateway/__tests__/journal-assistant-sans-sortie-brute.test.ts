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

const req = (useCaseCode: string, operationCode: string, schema: z.ZodType<unknown>) => ({
  useCaseCode: useCaseCode as never, operationCode, accountId: 1, promptVariables: { QUESTION: 'q' },
  outputSchema: schema, idempotencyKey: `k-${Math.random()}`, maxModelAttempts: 1,
});

describe('trace d’un appel de l’assistant', () => {
  it('succès : empreinte et longueur, jamais le texte', async () => {
    fake.onAny(() => ({ rawText: '{"ok":true,"secret":"IBAN FR76"}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req('INTELLIGENT_ASSISTANT', 'generate_answer', z.object({ ok: z.boolean() }).passthrough()));
    const t = h.traces.at(-1)!;
    expect(String(t.outputPreview)).toMatch(/^sha256:[0-9a-f]{12} len:\d+$/);
    expect(JSON.stringify(t)).not.toMatch(/IBAN|secret/);
  });

  it('sortie invalide : message d’erreur sans l’extrait brut', async () => {
    fake.onAny(() => ({ rawText: 'pas du json IBAN FR76', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req('INTELLIGENT_ASSISTANT', 'generate_answer', z.object({ ok: z.boolean() }))).catch(() => null);
    const t = h.traces.at(-1)!;
    expect(t.status).toBe('error');
    expect(String(t.errorMessage)).toMatch(/\[extrait non conservé\]/);
    expect(JSON.stringify(t)).not.toMatch(/IBAN/);
  });

  it('diagnostic explicite (flag) : extrait expurgé, comme les autres usages', async () => {
    process.env.VEREBONA_ASSISTANT_DIAGNOSTIC_PREVIEW = 'on';
    fake.onAny(() => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req('INTELLIGENT_ASSISTANT', 'generate_answer', z.object({ ok: z.boolean() })));
    expect(h.traces.at(-1)!.outputPreview).toBe('{"ok":true}');
  });

  it('les autres usages gardent leur extrait expurgé', async () => {
    fake.onAny(() => ({ rawText: '{"title":"Facture","amountCents":1}', inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req('SOURCE_ANALYSIS', 'classify_document', z.object({ title: z.string(), amountCents: z.number() })));
    expect(h.traces.at(-1)!.outputPreview).toBe('{"title":"Facture","amountCents":1}');
  });
});
