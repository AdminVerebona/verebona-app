/**
 * Lot 109L (ticket P1 « Tarifs Gemini non reconnus », point C, tests §4) —
 * statut tarifaire explicite, coût exact, jetons de raisonnement, complétude.
 */
import { describe, it, expect } from 'vitest';
import { completenessOf, pricingStatusOf, pricingStatusSql } from '../cost-status';
import { computeTracePricing } from '../trace-pricing';
import { exactCostMicros } from '../../gateway/cost-catalog';
import { averageCostPerCall } from '../cost-report.repository';

describe('statut à la création de la trace', () => {
  const s = (o: Partial<Parameters<typeof pricingStatusOf>[0]>) => pricingStatusOf({ status: 'success', inputTokens: 0, outputTokens: 0, costMicros: 0, priced: true, ...o });
  it('prix inconnu → missing (coût NULL), réponse métier conservée ailleurs', () => {
    expect(s({ inputTokens: 1000, outputTokens: 10, costMicros: null, priced: false })).toBe('missing');
  });
  it('coût < 1 micro arrondi à 0 avec tarif connu → zero_or_rounded, jamais « sans tarif »', () => {
    expect(s({ inputTokens: 2, outputTokens: 0, costMicros: 0, priced: true })).toBe('zero_or_rounded');
  });
  it('jetons d’entrée seuls / de sortie seuls', () => {
    expect(s({ inputTokens: 500, outputTokens: 0, costMicros: 150 })).toBe('applied');
    expect(s({ inputTokens: 0, outputTokens: 500, costMicros: null, priced: false })).toBe('missing');
    expect(s({ inputTokens: 0, outputTokens: 500, costMicros: 1250 })).toBe('applied');
  });
  it('0 jeton après refus (échec) : coût vraiment nul ; succès sans compteur : consommation non mesurée', () => {
    expect(s({ status: 'error', costMicros: 0, priced: false })).toBe('zero_or_rounded');
    expect(s({ status: 'success', costMicros: 0 })).toBe('insufficient_usage');
  });
  it('coût 0 avec jetons sans tarif (ancien code) : missing', () => {
    expect(s({ inputTokens: 10, costMicros: 0, priced: false })).toBe('missing');
  });
  it('déduction SQL des traces anciennes : statut écrit prioritaire, référence tarifaire comme preuve', () => {
    const sql = pricingStatusSql('u');
    expect(sql).toMatch(/u\.pricing_status IS NOT NULL THEN u\.pricing_status/);
    expect(sql).toMatch(/legacy_undetermined/);
    expect(sql).toMatch(/metadata \? 'pricing'/);
  });
});

describe('coût exact, paliers, montants datés, raisonnement', () => {
  const prix = { inputMicros: 0.75, outputMicros: 3.75, tiers: [
    { kind: 'dated' as const, from: null, to: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75 },
    { kind: 'dated' as const, from: '2027-01-01', to: null, inputPerMillion: 1.5, outputPerMillion: 7.5 },
  ] };
  it('montant daté en vigueur à la date de l’appel (tarification historique différente de la courante)', () => {
    expect(exactCostMicros(prix, 1_000_000, 0, 0, new Date('2026-11-04T00:00:00Z'))).toBe(750_000);
    expect(exactCostMicros(prix, 1_000_000, 0, 0, new Date('2027-02-01T00:00:00Z'))).toBe(1_500_000);
  });
  it('long contexte : toute la requête au palier', () => {
    const pro = { inputMicros: 1.25, outputMicros: 10, tiers: [{ kind: 'prompt_tokens_above' as const, thresholdTokens: 200_000, inputPerMillion: 2.5, outputPerMillion: 15 }] };
    expect(exactCostMicros(pro, 100_000, 1000, 0, new Date())).toBe(125_000 + 10_000);
    expect(exactCostMicros(pro, 300_000, 1000, 0, new Date())).toBe(750_000 + 15_000);
  });
  it('jetons de raisonnement au tarif de sortie ; coût exact fractionnaire conservé', () => {
    expect(exactCostMicros({ inputMicros: 0.3, outputMicros: 2.5, tiers: null }, 1, 0, 0, new Date())).toBeCloseTo(0.3);
    expect(exactCostMicros({ inputMicros: 0.3, outputMicros: 2.5, tiers: null }, 0, 10, 20, new Date())).toBe(75);
  });
});

describe('tarification figée à la trace', () => {
  const price = { costMicros: 0, exactMicros: 0, price: {} };
  const priceCall = (p: { inputTokens: number; outputTokens: number; thoughtsTokens?: number | null }) => {
    const exact = p.inputTokens * 0.3 + (p.outputTokens + (p.thoughtsTokens ?? 0)) * 2.5;
    return { costMicros: Math.round(exact), exactMicros: exact, price: {} };
  };
  it('raisonnement compté à part par Gemini : ajouté au coût (sortie « including thinking tokens »)', () => {
    const r = computeTracePricing({ provider: 'gemini', model: 'm', status: 'success', inputTokens: 1000, outputTokens: 100, costMicros: 550, providerMeta: { thoughtsTokens: 400 } }, { priceCall });
    expect(r).toMatchObject({ costMicros: 1550, status: 'applied', recomputed: true, usage: { thoughts: 400, thinkingCounted: true } });
  });
  it('jamais de double comptage si la sortie inclut déjà le raisonnement', () => {
    const r = computeTracePricing({ provider: 'gemini', model: 'm', status: 'success', inputTokens: 1000, outputTokens: 500, costMicros: 1550, providerMeta: { thoughtsTokens: 400, totalTokens: 1500 } }, { priceCall });
    expect(r).toMatchObject({ costMicros: 1550, recomputed: false });
  });
  it('arrondi au micro : statut zero_or_rounded et coût exact', () => {
    const r = computeTracePricing({ provider: 'gemini', model: 'm', status: 'success', inputTokens: 1, outputTokens: 0, costMicros: 0 }, { priceCall });
    expect(r).toMatchObject({ costMicros: 0, status: 'zero_or_rounded' });
    expect(r.exactMicros).toBeCloseTo(0.3);
  });
  it('sans tarif : coût NULL conservé, statut missing', () => {
    const r = computeTracePricing({ provider: 'gemini', model: 'x', status: 'success', inputTokens: 10, outputTokens: 10, costMicros: null }, { priceCall: () => ({ costMicros: null, exactMicros: null, price: null }) });
    expect(r).toMatchObject({ costMicros: null, status: 'missing', exactMicros: null });
    void price;
  });
});

describe('complétude et moyenne', () => {
  it('complet / partiel / inconnu', () => {
    expect(completenessOf(10, 0)).toBe('complete');
    expect(completenessOf(10, 3)).toBe('partial');
    expect(completenessOf(3, 3)).toBe('unknown');
  });
  it('moyenne sur les seuls appels chiffrés', () => {
    expect(averageCostPerCall({ calls: 10, unpricedCalls: 5, functionalMicros: 1000, technicalMicros: 0 })).toBe(200);
  });
});
