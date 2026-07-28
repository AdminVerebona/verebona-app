/**
 * Tests du regroupement — CDC §4.1.7 et §11.4.
 *
 * Enjeu de non-régression : « aucun document ne disparaît ». Une sortie modèle
 * imparfaite ne doit jamais faire perdre un fichier.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeGroups } from '../steps/group-sources.step';

describe('assainissement des groupes', () => {
  it('conserve un regroupement valide', () => {
    expect(sanitizeGroups([[0, 1], [2]], 3)).toEqual([[0, 1], [2]]);
  });

  it('récupère un fichier oublié par le modèle', () => {
    expect(sanitizeGroups([[0, 1]], 3)).toEqual([[0, 1], [2]]);
  });

  it('supprime les indices hors bornes sans perdre les autres', () => {
    expect(sanitizeGroups([[0, 99], [1]], 2)).toEqual([[0], [1]]);
  });

  it('ne place jamais un fichier dans deux groupes', () => {
    const groups = sanitizeGroups([[0, 1], [1, 2]], 3);
    const flat = groups.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.sort()).toEqual([0, 1, 2]);
  });

  it('renvoie un groupe par fichier si la sortie est vide', () => {
    expect(sanitizeGroups([], 2)).toEqual([[0], [1]]);
  });
});
