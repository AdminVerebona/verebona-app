/**
 * Catalogue tarifaire de l'assistant — CDC §15.9.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX ERREURS QUI NE SE VOIENT PAS
 *
 * · Un tarif inconnu rendu comme `0` produit un appel « gratuit » : le quota
 *   ne se décrémente pas, la dépense n'apparaît nulle part, et rien ne le
 *   signale.
 *
 * · Deux unités coexistent — micro-unités PAR TOKEN dans la grille officielle,
 *   dollars PAR MILLION de tokens dans les valeurs de secours. Les confondre
 *   décale le coût d'un facteur d'un million, sans qu'aucun résultat ne
 *   paraisse anormal.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { estimateCost, estimateCostMicros } from '@/services/verebona-assistant/registries/pricing-catalog';
import { primePricingCache, clearPricingCache } from '@/services/ai/gateway/pricing/pricing.repository';

describe('tarif inconnu', () => {
  beforeEach(() => clearPricingCache());

  it('rend null, jamais zéro', () => {
    // Zéro voudrait dire « gratuit ». Ce n'est pas la même chose que
    // « je ne sais pas ».
    expect(estimateCostMicros('modele-inexistant', 1000, 500)).toBeNull();
    expect(estimateCost('modele-inexistant', 1000, 500)).toMatchObject({
      micros: null, origin: 'unknown', reliable: false,
    });
  });
});

describe('grille officielle', () => {
  beforeEach(() => {
    clearPricingCache();
    primePricingCache([
      {
        provider: 'google', model: 'gemini-3.6-flash',
        // Micro-unités PAR TOKEN.
        inputMicros: 0.3, outputMicros: 2.5,
        currency: 'USD', verified: true, fetchedAt: new Date(), source: 'public_catalog',
      } as never,
    ]);
  });

  it('est préférée aux valeurs de secours', () => {
    const e = estimateCost('gemini-3.6-flash', 1_000_000, 100_000);
    expect(e.origin).toBe('official');
    expect(e.reliable).toBe(true);
  });

  it('applique le tarif PAR TOKEN, sans conversion parasite', () => {
    // 1 000 000 × 0,3 + 100 000 × 2,5 = 550 000 micro-dollars, soit 0,55 $.
    expect(estimateCost('gemini-3.6-flash', 1_000_000, 100_000).micros).toBe(550_000);
  });

  it('signale un tarif non vérifié sans le refuser', () => {
    clearPricingCache();
    primePricingCache([
      {
        provider: 'google', model: 'gemini-3.6-flash',
        inputMicros: 0.3, outputMicros: 2.5, currency: 'USD',
        verified: false, fetchedAt: new Date(), source: 'manual',
      } as never,
    ]);
    const e = estimateCost('gemini-3.6-flash', 1000, 100);
    expect(e.origin).toBe('official');
    // Utilisable, mais l'appelant doit savoir qu'il n'est pas confirmé.
    expect(e.reliable).toBe(false);
  });
});

describe('valeurs de secours', () => {
  beforeEach(() => clearPricingCache());

  it('prennent le relais quand la grille est vide', () => {
    // Sans repli, l'assistant cesserait d'estimer ses coûts dès qu'une
    // migration n'est pas appliquée.
    const e = estimateCost('gemini-2.5-flash-lite', 1_000_000, 1_000_000);
    expect(e.origin).toBe('fallback');
    expect(e.reliable).toBe(false);
  });

  it('convertissent correctement dollars par million en micro-dollars', () => {
    // 0,10 $/MTok en entrée et 0,40 $/MTok en sortie, sur un million de
    // chacun : 0,50 $ = 500 000 micro-dollars.
    expect(estimateCost('gemini-2.5-flash-lite', 1_000_000, 1_000_000).micros).toBe(500_000);
  });

  it('ne couvrent plus le modèle au tarif jamais confirmé', () => {
    // `gemini-3.1-flash-lite` portait la mention « à revérifier ». Mieux vaut
    // aucune estimation qu'une estimation inventée.
    expect(estimateCost('gemini-3.1-flash-lite', 1000, 100).origin).toBe('unknown');
  });
});
