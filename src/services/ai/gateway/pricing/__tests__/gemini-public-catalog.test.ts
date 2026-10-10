/**
 * Catalogue tarifaire public et détection d'écart.
 *
 * Ce qui est vérifié ici, c'est qu'un tarif faux ne peut pas passer par une
 * conversion d'unité erronée. Lot 35B : la lecture de la page officielle est
 * couverte par `google-pricing-page.test.ts` (adaptateur), le relevé embarqué
 * ne sert plus qu'à l'amorçage des modèles jamais évalués.
 */
import { describe, it, expect } from 'vitest';
import {
  GEMINI_PUBLIC_CATALOG,
  findCatalogEntry,
  toModelPrice,
  listSupersededModels,
} from '@/services/ai/gateway/pricing/gemini-public-catalog';

describe('catalogue tarifaire', () => {
  it('ne contient aucun doublon de modèle', () => {
    const models = GEMINI_PUBLIC_CATALOG.map((e) => e.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it('ne contient que des tarifs strictement positifs', () => {
    for (const entry of GEMINI_PUBLIC_CATALOG) {
      expect(entry.inputPerMillion).toBeGreaterThan(0);
      expect(entry.outputPerMillion).toBeGreaterThan(0);
    }
  });

  it('facture toujours la sortie au moins aussi cher que l’entrée', () => {
    // Vrai pour tous les modèles Gemini. Un manquement signalerait une
    // inversion entrée/sortie à la saisie — l'erreur la plus probable.
    for (const entry of GEMINI_PUBLIC_CATALOG) {
      expect(entry.outputPerMillion).toBeGreaterThanOrEqual(entry.inputPerMillion);
    }
  });

  it('convertit les dollars par million en micro-dollars par token', () => {
    // $1.50 / 1M tokens = 1,5 micro-dollar par token : identité numérique.
    const price = toModelPrice(findCatalogEntry('gemini-3.6-flash')!);
    expect(price.inputMicros).toBe(1.5);
    expect(price.outputMicros).toBe(7.5);
    expect(price.currency).toBe('USD');
    expect(price.provider).toBe('gemini');
  });

  it('signale les modèles remplacés par une version plus récente', () => {
    const superseded = listSupersededModels();
    expect(superseded.map((e) => e.model)).toContain('gemini-3.5-flash');
    expect(findCatalogEntry('gemini-3.5-flash')!.supersededBy).toBe('gemini-3.6-flash');
  });

  it('ne connaît pas de modèle inventé', () => {
    expect(findCatalogEntry('gemini-42-ultra')).toBeUndefined();
  });
});
