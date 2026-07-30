/**
 * Catalogue tarifaire public et détection d'écart.
 *
 * Ce qui est vérifié ici, c'est qu'un tarif faux ne peut pas passer : ni par
 * une conversion d'unité erronée, ni par un changement silencieux de la page
 * officielle.
 */
import { describe, it, expect } from 'vitest';
import {
  GEMINI_PUBLIC_CATALOG,
  findCatalogEntry,
  toModelPrice,
  listSupersededModels,
} from '@/services/ai/gateway/pricing/gemini-public-catalog';
import {
  sliceModelSection,
  extractAmounts,
  checkModelDrift,
} from '@/services/ai/gateway/pricing/gemini-public.source';

/** Extrait de la page officielle, réduit aux éléments utiles au contrôle. */
const PAGE = `
## Gemini 3.6 Flash

*\`gemini-3.6-flash\`*

| Input price  | Free of charge | $1.50 |
| Output price | Free of charge | $7.50 |

## Gemini 3.1 Flash-Lite

*\`gemini-3.1-flash-lite\`*

| Input price  | Free of charge | $0.25 (text / image / video)   $0.50 (audio) |
| Output price | Free of charge | $1.50 |

## Gemini 2.5 Flash-Lite

*\`gemini-2.5-flash-lite\`*

| Input price  | Free of charge | $0.10 (text / image / video)   $0.30 (audio) |
| Output price | Free of charge | $0.40 |
`;

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

describe('découpage de la page officielle', () => {
  it('isole la section d’un modèle', () => {
    const section = sliceModelSection(PAGE, 'gemini-3.6-flash')!;
    expect(section).toContain('$7.50');
    // Ne doit pas déborder sur le modèle suivant.
    expect(section).not.toContain('gemini-3.1-flash-lite');
  });

  it('retourne null pour un modèle absent de la page', () => {
    expect(sliceModelSection(PAGE, 'gemini-42-ultra')).toBeNull();
  });

  it('relève tous les montants d’une section', () => {
    const amounts = extractAmounts(sliceModelSection(PAGE, 'gemini-3.1-flash-lite')!);
    expect(amounts).toContain(0.25);
    expect(amounts).toContain(0.5); // tarif audio
    expect(amounts).toContain(1.5);
  });
});

describe('détection d’écart', () => {
  it('confirme un tarif toujours présent sur la page', () => {
    expect(checkModelDrift(PAGE, 'gemini-3.6-flash')).toEqual({
      model: 'gemini-3.6-flash',
      status: 'verified',
    });
  });

  it('confirme un tarif malgré plusieurs montants dans la même cellule', () => {
    // L'entrée de 3.1 Flash-Lite affiche un tarif texte ET un tarif audio.
    expect(checkModelDrift(PAGE, 'gemini-3.1-flash-lite').status).toBe('verified');
  });

  it('signale un écart lorsque le montant a changé', () => {
    const changed = PAGE.replace('$7.50', '$6.00');
    const report = checkModelDrift(changed, 'gemini-3.6-flash');
    expect(report.status).toBe('drifted');
    expect(report.detail).toContain('sortie 7.5');
  });

  it('signale un écart lorsque le modèle disparaît de la page', () => {
    const report = checkModelDrift(PAGE, 'gemini-2.5-pro');
    expect(report.status).toBe('drifted');
    expect(report.detail).toContain('introuvable');
  });

  it('ne se prononce pas sur un modèle absent du catalogue', () => {
    expect(checkModelDrift(PAGE, 'gemini-42-ultra').status).toBe('unverified');
  });
});
