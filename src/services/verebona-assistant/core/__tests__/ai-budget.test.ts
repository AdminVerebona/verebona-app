/**
 * Budget d'appels modèle par message — CDC §15.5, §0.9, CA-07.
 *
 * « Le total ne peut jamais dépasser 2 appels » par message utilisateur,
 * toutes opérations confondues (classification, revalidation, génération,
 * replis compris). Les appels sont comptés au niveau du FOURNISSEUR (faux
 * provider installé par `src/test/setup.ts`) : c'est ce qui est facturé.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { fakeProvider } from '@/test/setup';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune base en test'); }) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
const { createAiCallBudget, executeWithinBudget } = await import('../ai-call-budget');
const { runAssistant } = await import('../assistant-orchestrator.service');
const { classifyAssistantIntent } = await import('../classification.adapter');
const { generateAssistantAnswer } = await import('../generation.adapter');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;
type Input = import('../../types/contracts').AssistantRequestInput;
type Source = import('../../types/sources').RetrievedSource;

const SOURCES: Source[] = [
  { id: 'doc_1', type: 'document', title: 'Garantie vélo', content: 'Garantie 2 ans à compter du 12/03/2024.', relevanceScore: 0.9 },
  { id: 'doc_2', type: 'document', title: 'Facture vélo', content: 'Facture du 12/03/2024, 1 290 €.', relevanceScore: 0.8 },
] as Source[];

const INPUT: Input = {
  accountId: 7, userId: 3, planType: 'PREMIUM',
  // Aucune règle déterministe : classification par modèle nécessaire.
  message: 'raconte-moi un truc sur ce que je possède',
  clientRequestId: 'req-1', locale: 'fr-FR',
};

function ports(over: Partial<Ports> = {}): Ports {
  return {
    retrieve: async () => SOURCES,
    resolveSources: async (s) => s.map((x) => ({
      sourceId: x.id, type: x.type, title: x.title, excerpt: x.content, available: true, href: null,
    })) as never,
    resolveActions: async () => [],
    persist: async () => null,
    hasPendingClarification: async () => false,
    classifyWithAI: classifyAssistantIntent,
    generateWithAI: generateAssistantAnswer,
    ...over,
  };
}

const CLASSIFICATION = JSON.stringify({ intent: 'ACCOUNT_SUMMARY', confidence: 'probable', entityHints: [], reason: 'synthèse' });

beforeEach(() => {
  delete process.env.VEREBONA_ASSISTANT_MAX_AI_CALLS_PER_REQUEST;
});

describe('gateway : maxModelAttempts tronque la chaîne de repli', () => {
  const Schema = z.object({ ok: z.boolean() });
  const req = { useCaseCode: 'INTELLIGENT_ASSISTANT' as const, operationCode: 'generate_answer', accountId: 1, promptVariables: {}, outputSchema: Schema };

  it('sans budget : principal puis repli', async () => {
    fakeProvider.onAny(() => { throw new Error('503'); });
    await expect(AiGateway.execute({ ...req, idempotencyKey: `k-${Math.random()}` })).rejects.toBeTruthy();
    expect(fakeProvider.calls.length).toBe(2);
  });

  it('maxModelAttempts = 1 : un seul modèle sollicité', async () => {
    fakeProvider.onAny(() => { throw new Error('503'); });
    await expect(AiGateway.execute({ ...req, maxModelAttempts: 1, idempotencyKey: `k-${Math.random()}` })).rejects.toBeTruthy();
    expect(fakeProvider.calls.length).toBe(1);
  });

  it('maxModelAttempts = 0 : aucun appel fournisseur', async () => {
    await expect(AiGateway.execute({ ...req, maxModelAttempts: 0, idempotencyKey: `k-${Math.random()}` })).rejects.toBeTruthy();
    expect(fakeProvider.calls.length).toBe(0);
  });
});

describe('AiCallBudget', () => {
  it('décompte 1 sur succès direct, tout le permis sur échec, refuse une fois épuisé', async () => {
    const b = createAiCallBudget(2);
    const Schema = z.object({ ok: z.boolean() });
    const req = { useCaseCode: 'INTELLIGENT_ASSISTANT' as const, operationCode: 'generate_answer', accountId: 1, promptVariables: {}, outputSchema: Schema };
    fakeProvider.onAny(() => ({ rawText: '{"ok":true}', inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(b, { ...req, idempotencyKey: `k-${Math.random()}` });
    expect(b.used).toBe(1);
    fakeProvider.onAny(() => { throw new Error('503'); });
    await expect(executeWithinBudget(b, { ...req, idempotencyKey: `k-${Math.random()}` })).rejects.toBeTruthy();
    expect(b.used).toBe(2);
    const avant = fakeProvider.calls.length;
    await expect(executeWithinBudget(b, { ...req, idempotencyKey: `k-${Math.random()}` })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(fakeProvider.calls.length).toBe(avant);
  });
});

describe('orchestrateur : au plus 2 appels modèle par message (CA-07)', () => {
  it('classification réussie puis génération en échec : 2 appels, pas 3', async () => {
    let n = 0;
    fakeProvider.onAny(() => {
      n += 1;
      if (n === 1) return { rawText: CLASSIFICATION, inputTokens: 10, outputTokens: 5 };
      throw new Error('503 indisponible');
    });
    const r = await runAssistant(INPUT, ports());
    expect(fakeProvider.calls.length).toBeLessThanOrEqual(2);
    expect(fakeProvider.calls.length).toBe(2);
    expect(r.cascade?.aiCalls).toBe(2);
    // Repli déterministe avec les sources, jamais une erreur.
    expect(r.error).toBeUndefined();
    expect(r.mode).not.toBe('ai');
  });

  it('classification en échec sur les 2 modèles : la génération n’est pas tentée', async () => {
    fakeProvider.onAny(() => { throw new Error('503 indisponible'); });
    const generate = vi.fn(generateAssistantAnswer);
    const r = await runAssistant(INPUT, ports({ generateWithAI: generate }));
    expect(fakeProvider.calls.length).toBe(2);
    expect(r.cascade?.escalationReasons.join(' ')).not.toMatch(/GENERATION_UNAVAILABLE/);
  });

  it('succès nominal : classification + génération = 2 appels', async () => {
    let n = 0;
    fakeProvider.onAny(() => {
      n += 1;
      if (n === 1) return { rawText: CLASSIFICATION, inputTokens: 10, outputTokens: 5 };
      return { rawText: JSON.stringify({ claims: [{ text: 'La garantie court 2 ans à compter du 12/03/2024.', sourceIds: ['doc_1'], factual: true }], status: 'answered' }), inputTokens: 10, outputTokens: 5 };
    });
    const r = await runAssistant(INPUT, ports());
    expect(fakeProvider.calls.length).toBe(2);
    expect(r.mode).toBe('ai');
  });

  it('revalidation (2 appels) : ni classification ni génération ensuite', async () => {
    const classify = vi.fn(async () => null);
    const generate = vi.fn(async () => null);
    const r = await runAssistant(
      INPUT,
      ports({
        answerFromData: async () => ({
          handled: false, answer: null, claims: [], sources: [], contextSources: SOURCES, attempts: [],
          decision: { status: 'INSUFFICIENT', level: 2, score: 0, threshold: 1, reason: 'LOW' },
          revalidation: { trigger: 'LOW_CONFIDENCE', factIds: [1, 2, 3] },
          strategy: 'x',
        }) as never,
        // Port tiers qui ne décompte pas lui-même : l'orchestrateur rattrape
        // les 2 appels déclarés sur le budget.
        revalidateFacts: async () => ({
          results: [{ factId: 1, trigger: 'LOW_CONFIDENCE', mode: 'PERSISTED_CONTENT', status: 'AMBIGUOUS', reused: false, reinjectedFactId: null, aiCalls: 2, model: 'm' }],
          established: false,
        }),
        classifyWithAI: classify,
        generateWithAI: generate,
      }),
    );
    expect(classify).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(r.cascade?.aiCalls).toBe(2);
    expect(r.cascade?.escalationReasons).toContain('ROUTING:AI_BUDGET_EXHAUSTED');
  });
});
