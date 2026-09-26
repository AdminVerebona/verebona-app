/**
 * COST-007 : référence tarifaire figée avec chaque appel (metadata.pricing).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../gateway/pricing/pricing.repository', () => ({
  getCachedPrice: (provider: string, model: string) => (model === 'connu'
    ? { provider, model, inputMicros: 0.1, outputMicros: 0.4, currency: 'USD', source: 'manual', verified: true, fetchedAt: new Date() }
    : null),
}));

const { pricingRef } = await import('../ai-trace.service');

describe('pricingRef', () => {
  it('fige le tarif appliqué', () => {
    expect(pricingRef('gemini', 'connu')).toEqual({ inputMicros: 0.1, outputMicros: 0.4, currency: 'USD', source: 'manual', verified: true });
  });
  it('sans tarif : null (coût non calculable, jamais inventé)', () => {
    expect(pricingRef('gemini', 'inconnu')).toBeNull();
  });
});
