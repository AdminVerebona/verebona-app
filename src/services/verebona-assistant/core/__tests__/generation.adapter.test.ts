/**
 * CDC §15.1, §12.4 et §30.3 — génération sourcée de l'assistant.
 *
 * Deux propriétés sont protégées ici :
 *   • une affirmation citant une source inexistante est SUPPRIMÉE. Le prompt
 *     l'annonce ; c'est le serveur qui doit l'appliquer, pas la bonne volonté
 *     du modèle.
 *   • une génération qui échoue rend `null`, jamais une exception : le repli
 *     déterministe reste une dégradation prévue, pas une panne.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RetrievedSource } from '../../types/sources';

const execute = vi.fn();
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute: (...a: unknown[]) => execute(...a) } }));

const {
  generateAssistantAnswer, toGeneratedAnswer, computeSupportLevel, buildGenerationPort,
} = await import('../generation.adapter');

const src = (id: string): RetrievedSource => ({
  id, type: 'document', title: `Titre ${id}`, content: 'Extrait',
} as RetrievedSource);

const input = { accountId: 1, userId: 2, message: 'Quelle surface ?' } as never;
const route = { intent: 'ASSET_INFO' } as never;

beforeEach(() => {
  execute.mockReset();
  delete process.env.AI_INTELLIGENT_ASSISTANT;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('filtrage des affirmations', () => {
  it('conserve celles dont toutes les sources existent', () => {
    const out = toGeneratedAnswer(
      { answer: 'R', claims: [{ text: 'A', sourceIds: ['doc_1'] }], actionIntents: [], derivations: [] },
      [src('doc_1')],
    );
    expect(out.claims).toHaveLength(1);
    expect(out.supportLevel).toBe('supported');
  });

  it('SUPPRIME celle qui cite une source inexistante', () => {
    const out = toGeneratedAnswer(
      { answer: 'R', claims: [{ text: 'A', sourceIds: ['doc_99'] }], actionIntents: [], derivations: [] },
      [src('doc_1')],
    );
    expect(out.claims).toEqual([]);
    expect(out.supportLevel).toBe('insufficient');
  });

  it('exige que TOUTES les sources d\'une affirmation soient connues', () => {
    const out = toGeneratedAnswer(
      { answer: 'R', claims: [{ text: 'A', sourceIds: ['doc_1', 'doc_99'] }], actionIntents: [], derivations: [] },
      [src('doc_1')],
    );
    expect(out.claims).toEqual([]);
  });

  it('signale une réponse amputée plutôt que de l\'annoncer entière', () => {
    const out = toGeneratedAnswer(
      { answer: 'R', claims: [
        { text: 'A', sourceIds: ['doc_1'] },
        { text: 'B', sourceIds: ['doc_99'] },
      ], actionIntents: [], derivations: [] },
      [src('doc_1')],
    );
    expect(out.claims).toHaveLength(1);
    expect(out.supportLevel).toBe('partial');
  });

  it('retombe sur `synthesized` quand la nature n\'est pas précisée', () => {
    const out = toGeneratedAnswer(
      { answer: 'R', claims: [{ text: 'A', sourceIds: ['doc_1'] }], actionIntents: [], derivations: [] },
      [src('doc_1')],
    );
    expect(out.claims[0].derivation).toBe('synthesized');
  });

  it('respecte la nature déclarée', () => {
    const out = toGeneratedAnswer(
      { answer: 'R', claims: [{ text: 'A', sourceIds: ['doc_1'] }], actionIntents: [], derivations: ['direct'] },
      [src('doc_1')],
    );
    expect(out.claims[0].derivation).toBe('direct');
  });
});

describe('niveau d\'étayage', () => {
  it('couvre les trois cas', () => {
    expect(computeSupportLevel(0, 0)).toBe('insufficient');
    expect(computeSupportLevel(3, 0)).toBe('insufficient');
    expect(computeSupportLevel(3, 2)).toBe('partial');
    expect(computeSupportLevel(3, 3)).toBe('supported');
  });
});

describe('appel', () => {
  it('n\'appelle pas le modèle sans source — §15.1', async () => {
    expect(await generateAssistantAnswer(route, [], input)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('déclare l\'usage et l\'opération du référentiel', async () => {
    execute.mockResolvedValue({ data: { answer: 'R', claims: [], actionIntents: [], derivations: [] } });
    await generateAssistantAnswer(route, [src('doc_1')], input);

    expect(execute.mock.calls[0][0]).toMatchObject({
      useCaseCode: 'INTELLIGENT_ASSISTANT',
      operationCode: 'generate_answer',
      accountId: 1,
    });
  });

  it('rend null plutôt que de lever — le repli déterministe reste prévu', async () => {
    execute.mockRejectedValue(new Error('délai dépassé'));
    await expect(generateAssistantAnswer(route, [src('doc_1')], input)).resolves.toBeNull();
  });
});

describe('gouvernance par le drapeau', () => {
  it('laisse le port INDÉFINI tant que l\'usage n\'est pas basculé', () => {
    // Indéfini et non « fonction inerte » : l'orchestrateur teste la présence
    // du port pour décider d'entrer dans l'état GENERATING.
    expect(buildGenerationPort()).toBeUndefined();
  });

  it('fournit le port une fois l\'usage activé', () => {
    process.env.AI_INTELLIGENT_ASSISTANT = 'enabled';
    expect(typeof buildGenerationPort()).toBe('function');
  });
});
