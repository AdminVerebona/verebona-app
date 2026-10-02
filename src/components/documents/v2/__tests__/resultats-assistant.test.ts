/**
 * D-J3 (lot 21) — Mes documents filtrés sur les résultats d'une recherche de
 * l'assistant (`?resultats=`, posé par `/api/verebona/search-results` après
 * revérification par compte). Lecture défensive de l'URL.
 */
import { describe, it, expect } from 'vitest';
import { libelleResultats, parseSearchResults } from '../documents-view';

describe('?resultats=', () => {
  it('identifiants entiers positifs, 50 au plus', () => {
    expect(parseSearchResults('3,4,x,-1,4.5,9')).toEqual([3, 4, 9]);
    expect(parseSearchResults(Array.from({ length: 80 }, (_, i) => i + 1).join(','))).toHaveLength(50);
  });
  it('absent ou vide : pas de filtre', () => {
    expect(parseSearchResults(null)).toBeNull();
    expect(parseSearchResults('abc')).toBeNull();
  });
  it('« aucun » (documents tous disparus) : filtre vide, pas la liste complète', () => {
    expect(parseSearchResults('aucun')).toEqual([]);
  });
  it('bandeau : nombre de documents trouvés, « aucun résultat » à zéro', () => {
    expect(libelleResultats(0)).toBe('aucun résultat');
    expect(libelleResultats(1)).toBe('1 document');
    expect(libelleResultats(3)).toBe('3 documents');
  });
});
