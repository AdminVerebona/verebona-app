/**
 * Requêtes mixtes : répondre à la partie autorisée, refuser seulement la
 * partie interdite (FULLY_ALLOWED / PARTIALLY_ALLOWED / FULLY_BLOCKED).
 */
import { describe, it, expect, vi } from 'vitest';
import { analyzeScope, checkBlockedTopic } from '../blocked-topics';
import { runAssistant, type OrchestratorPorts } from '../assistant-orchestrator.service';
import type { AssistantRequestInput } from '../../types/contracts';

describe('classement par sous-demande', () => {
  it('donnée + conseil : partiellement autorisé', () => {
    const r = analyzeScope('Quelle est la date d’échéance de mon assurance habitation et est-ce que je devrais changer d’assureur ?');
    expect(r.kind).toBe('PARTIALLY_ALLOWED');
    expect(r.parts.map((p) => p.allowed)).toEqual([true, false]);
    expect(r.parts[1].reason).toBe('insurance_advice');
    expect(r.allowedText).toBe('Quelle est la date d’échéance de mon assurance habitation ?');
    expect(r.refusal).toMatch(/pas vous conseiller sur le choix ou le changement de votre assurance/);
  });

  it.each([
    ['Quel montant de taxe foncière figure sur mon avis et comment réduire mes impôts ?', 'tax'],
    ['Quelle durée de préavis est écrite dans mon bail ? Est-ce que ce préavis est légal ?', 'legal'],
  ])('« %s » → partie factuelle conservée, refus %s', (q, reason) => {
    const r = analyzeScope(q);
    expect(r.kind).toBe('PARTIALLY_ALLOWED');
    expect(r.reasons).toEqual([reason]);
  });

  it('entièrement autorisé : parcours inchangé', () => {
    for (const q of ['Quelle est ma franchise ?', 'Quelle est la date d’échéance de mon contrat ?', 'Quelle durée de préavis est écrite dans mon bail ?']) {
      const r = analyzeScope(q);
      expect(r.kind).toBe('FULLY_ALLOWED');
      expect(r.allowedText).toBe(q);
    }
  });

  it('entièrement interdit : refus', () => {
    for (const q of ['Est-ce que je devrais changer d’assurance ?', 'Est-ce une bonne franchise ?', 'Comment réduire mes impôts ?']) {
      expect(analyzeScope(q).kind).toBe('FULLY_BLOCKED');
    }
  });

  it('appréciation mêlée à une donnée : clarification plutôt que refus global', () => {
    const r = analyzeScope('Que penser de ma franchise de 1 500 € ?');
    expect(r.kind).toBe('AMBIGUOUS');
    expect(r.clarification).toMatch(/Voulez-vous que je retrouve cette information/);
  });

  it('le thème seul ne bloque pas : la provenance compte avant le sujet', () => {
    expect(checkBlockedTopic('Quel montant de taxe foncière figure sur mon avis ?').blocked).toBe(false);
  });
});

describe('orchestration', () => {
  const input = (message: string): AssistantRequestInput => ({
    accountId: 1, userId: 2, planType: 'PREMIUM', message, clientRequestId: 'x', locale: 'fr-FR',
  });
  const ports = () => {
    const vus: string[] = [];
    const p: OrchestratorPorts = {
      retrieve: vi.fn(async () => []),
      resolveSources: async () => [],
      resolveActions: async () => [],
      persist: vi.fn(async () => null),
      hasPendingClarification: async () => false,
      answerFromData: vi.fn(async (_r, i) => {
        vus.push(i.message);
        return {
          handled: true, answer: 'Votre contrat arrive à échéance le 14 novembre 2026.', sources: [], claims: [],
          decision: { status: 'SUFFICIENT_STRUCTURED', level: 1, score: 1, threshold: 0.5 }, strategy: 'structured.deadline_of', attempts: [], contextSources: [],
        } as never;
      }),
    };
    return { p, vus };
  };

  it('partie autorisée traitée, partie interdite refusée — et jamais envoyée aux données', async () => {
    const { p, vus } = ports();
    const r = await runAssistant(input('Quelle est la date d’échéance de mon assurance habitation et est-ce que je devrais changer d’assureur ?'), p);
    expect(vus).toEqual(['Quelle est la date d’échéance de mon assurance habitation ?']);
    expect(r.answer).toMatch(/^Votre contrat arrive à échéance le 14 novembre 2026\.\n\nEn revanche/);
    expect(r.cascade?.scope?.kind).toBe('PARTIALLY_ALLOWED');
    expect(r.blockedReason).toBe('insurance_advice');
  });

  it('historique : la question telle que posée', async () => {
    const { p } = ports();
    await runAssistant(input('Quelle est la date d’échéance de mon assurance et est-ce que je devrais changer d’assureur ?'), p);
    const persisted = (p.persist as ReturnType<typeof vi.fn>).mock.calls[0][1] as AssistantRequestInput;
    expect(persisted.originalMessage).toMatch(/changer d’assureur/);
  });

  it('entièrement interdit : ni retrieval, ni données, ni modèle', async () => {
    const { p } = ports();
    const r = await runAssistant(input('Est-ce que je devrais changer d’assurance ?'), p);
    expect(p.answerFromData).not.toHaveBeenCalled();
    expect(p.retrieve).not.toHaveBeenCalled();
    expect(r.sources).toEqual([]);
    expect(r.scope?.kind).toBe('FULLY_BLOCKED');
  });
});
