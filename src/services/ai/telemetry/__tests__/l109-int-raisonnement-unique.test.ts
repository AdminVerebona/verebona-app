/**
 * Intégration lot 109 (109J × 109L) — les jetons de raisonnement ne sont
 * comptés qu'UNE fois. 109J les ajoute au coût calculé par la passerelle ;
 * 109L recalcule le coût de la trace à partir des jetons (entrée, sortie
 * visible, raisonnement) : le recalcul REMPLACE le coût, il ne l'additionne
 * jamais. Sur un coût déjà calculé avec le raisonnement, la trace est inchangée.
 */
import { describe, it, expect } from 'vitest';
import { computeTracePricing } from '../trace-pricing';

// Tarif fictif : 1 micro par jeton d'entrée, 4 micros par jeton de sortie (raisonnement compris).
const priceCall = (p: { inputTokens: number; outputTokens: number; thoughtsTokens?: number | null }) => {
  const c = p.inputTokens * 1 + (p.outputTokens + (p.thoughtsTokens ?? 0)) * 4;
  return { costMicros: c, exactMicros: c, price: {} };
};
const base = { provider: 'gemini', model: 'gemini-3.6-flash', status: 'success' as const, inputTokens: 48_312, outputTokens: 324 };
const thoughts = 7_868;

describe('L109-INT — raisonnement compté une seule fois (passerelle 109J → trace 109L)', () => {
  it('coût de la passerelle déjà avec le raisonnement : trace identique, aucun ajout', () => {
    const passerelle = base.inputTokens + (base.outputTokens + thoughts) * 4;
    const r = computeTracePricing({ ...base, costMicros: passerelle, providerMeta: { thoughtsTokens: thoughts } }, { priceCall });
    expect(r.costMicros).toBe(passerelle);
    expect(r.recomputed).toBe(false);
    expect(r.usage).toMatchObject({ output: 324, thoughts, thinkingCounted: true });
  });
  it('coût transmis SANS le raisonnement (ancien chemin) : remplacé une fois par le coût complet', () => {
    const sansRaisonnement = base.inputTokens + base.outputTokens * 4;
    const r = computeTracePricing({ ...base, costMicros: sansRaisonnement, providerMeta: { thoughtsTokens: thoughts } }, { priceCall });
    expect(r.costMicros).toBe(base.inputTokens + (base.outputTokens + thoughts) * 4);
    expect(r.recomputed).toBe(true);
  });
  it('sortie déjà marquée comme incluant le raisonnement : jamais ajouté', () => {
    const r = computeTracePricing({ ...base, outputTokens: 324 + thoughts, costMicros: base.inputTokens + (324 + thoughts) * 4, providerMeta: { thoughtsTokens: thoughts, outputIncludesThoughts: true } }, { priceCall });
    expect(r.costMicros).toBe(base.inputTokens + (324 + thoughts) * 4);
    expect(r.usage.thoughts).toBeNull();
  });
});
