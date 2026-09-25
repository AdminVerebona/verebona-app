/**
 * Aucun fait non validé par les sources dans le texte affiché — CDC §12.4.
 *
 * Le filtrage écartait les affirmations mal sourcées de la liste des
 * citations, mais le texte `answer` du modèle était rendu tel quel : le fait
 * rejeté restait lisible. La réponse est désormais reconstruite à partir des
 * seules affirmations validées.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RetrievedSource } from '../../types/sources';

const execute = vi.fn();
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute: (...a: unknown[]) => execute(...a) } }));
const { toGeneratedAnswer, generateAssistantAnswer } = await import('../generation.adapter');

const src = (id: string): RetrievedSource => ({ id, type: 'document', title: `Titre ${id}`, content: 'Extrait' } as RetrievedSource);
const base = { actionIntents: [], derivations: [] };

beforeEach(() => { execute.mockReset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('réponse partiellement sourcée', () => {
  const data = {
    ...base,
    answer: 'Votre prime est de 480 €. Votre franchise est de 150 €.',
    claims: [
      { text: 'Voici ce que j’ai trouvé.', sourceIds: [], factual: false },
      { text: 'Votre prime annuelle est de 480 €.', sourceIds: ['doc_1'], factual: true },
      { text: 'Votre franchise est de 150 €.', sourceIds: ['doc_404'], factual: true },
    ],
  };

  it('le fait sourcé reste, le fait au sourceId inexistant disparaît du TEXTE', () => {
    const out = toGeneratedAnswer(data, [src('doc_1')])!;
    expect(out.answer).toContain('480 €');
    expect(out.answer).not.toContain('150 €');
    expect(out.answer).not.toBe(data.answer);
    expect(out.supportLevel).toBe('partial');
  });

  it('la phrase de transition sans donnée est conservée', () => {
    expect(toGeneratedAnswer(data, [src('doc_1')])!.answer.startsWith('Voici ce que j’ai trouvé.')).toBe(true);
  });
});

describe('réponse entièrement non étayée', () => {
  it('aucune affirmation affichée : repli déterministe (null)', () => {
    const out = toGeneratedAnswer({
      ...base,
      answer: 'Votre maison vaut 350 000 €.',
      claims: [{ text: 'Votre maison vaut 350 000 €.', sourceIds: ['doc_9'], factual: true }],
    }, [src('doc_1')]);
    expect(out).toBeNull();
  });

  it('un texte libre sans aucune citation n’est jamais repris', () => {
    expect(toGeneratedAnswer({ ...base, answer: 'La moyenne du marché est de 3 %.', claims: [] }, [src('doc_1')])).toBeNull();
  });

  it('une « transition » qui porte une donnée est traitée comme un fait — et rejetée sans source', () => {
    const out = toGeneratedAnswer({
      ...base,
      claims: [
        { text: 'En général, une prime tourne autour de 400 €.', sourceIds: [], factual: false },
        { text: 'Votre contrat est chez AXA.', sourceIds: ['doc_1'], factual: true },
      ],
    }, [src('doc_1')])!;
    expect(out.answer).toBe('Votre contrat est chez AXA.');
  });

  it('« données insuffisantes » : l’explication sans donnée est une réponse sûre', () => {
    const out = toGeneratedAnswer({
      ...base, status: 'insufficient_data',
      claims: [{ text: 'Vos documents ne mentionnent pas la franchise.', sourceIds: [], factual: false }],
    }, [src('doc_1')])!;
    expect(out.answer).toBe('Vos documents ne mentionnent pas la franchise.');
    expect(out.supportLevel).toBe('insufficient');
  });
});

describe('bout en bout de l’adaptateur', () => {
  it('génération sans fait validé → null (l’orchestrateur répond par le repli sources)', async () => {
    execute.mockResolvedValue({ data: { claims: [{ text: 'Faux 12 €', sourceIds: ['doc_x'] }] }, model: 'm' });
    expect(await generateAssistantAnswer({ intent: 'ACCOUNT_SUMMARY' } as never, [src('doc_1')], { accountId: 1, userId: 2, message: 'x' } as never)).toBeNull();
  });

  it('identifiants numériques du prompt acceptés et comparés aux sources réelles', () => {
    const out = toGeneratedAnswer({ ...base, claims: [{ text: 'Prime 480 €.', sourceIds: ['11'], factual: true }] }, [src('11')]);
    expect(out?.answer).toBe('Prime 480 €.');
  });
});
