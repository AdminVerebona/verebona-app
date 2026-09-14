/**
 * Pagination et filtres par Rubrique — CDC V2.0 §4.6, §16.3.
 *
 * Le comportement testé ici est celui qu'une optimisation bien intentionnée
 * casse en premier : « Voir les N autres » AJOUTE à ce qui est affiché, il ne
 * remplace pas la page précédente.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_V2_FILTERS,
  activeFilterCount,
  type DocumentsV2Filters,
} from '@/components/documents/v2/DocumentsFilterDrawer';

/** Reproduit la règle de fenêtre appliquée côté serveur. */
function shown(pageSize: number, offset: number): number {
  return offset + pageSize;
}

describe('fenêtre d’affichage par groupe (§16.3)', () => {
  it('cumule au lieu de glisser', () => {
    expect(shown(6, 0)).toBe(6);
    expect(shown(6, 6)).toBe(12);
    expect(shown(6, 12)).toBe(18);
  });

  it('« encore N » se calcule sur le total, pas sur la page', () => {
    const count = 40;
    expect(count - shown(6, 6)).toBe(28);
  });
});

describe('compteur de filtres actifs (§4.6)', () => {
  it('ne compte rien quand rien n’est posé', () => {
    expect(activeFilterCount(DEFAULT_V2_FILTERS)).toBe(0);
  });

  it('compte biens et types séparément', () => {
    const filters: DocumentsV2Filters = {
      ...DEFAULT_V2_FILTERS,
      assetIds: [1, 2],
      typeCodes: ['DPE'],
    };
    expect(activeFilterCount(filters)).toBe(3);
  });

  it('compte le tri comme un filtre dès qu’il quitte le défaut', () => {
    expect(activeFilterCount({ ...DEFAULT_V2_FILTERS, sort: 'title' })).toBe(1);
    expect(activeFilterCount({ ...DEFAULT_V2_FILTERS, direction: 'asc' })).toBe(1);
  });

  it('le tri par défaut est « date d’ajout décroissante » (§4.6)', () => {
    expect(DEFAULT_V2_FILTERS.sort).toBe('uploadedAt');
    expect(DEFAULT_V2_FILTERS.direction).toBe('desc');
  });

  it('UX-01 — aucun champ de recherche dans le contrat de filtres', () => {
    // Le §4.2 interdit la recherche locale. Un champ ajouté de bonne foi
    // apparaîtrait ici en premier.
    expect(Object.keys(DEFAULT_V2_FILTERS)).not.toContain('search');
    expect(Object.keys(DEFAULT_V2_FILTERS)).not.toContain('query');
  });
});
