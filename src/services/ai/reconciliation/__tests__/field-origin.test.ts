/**
 * Tests de l'origine des champs — CDC §6.2.
 *
 * La lecture rétrocompatible est le point le plus risqué de la migration : une
 * erreur d'interprétation revient à écraser une saisie utilisateur.
 */
import { describe, it, expect } from 'vitest';
import { readOrigin, writeOrigin, isHumanOrigin } from '../field-origin';

describe('lecture de l\'origine', () => {
  it('lit le format cible', () => {
    expect(readOrigin({ acquisitionPrice__origin: 'RECONCILIATION' }, 'acquisitionPrice'))
      .toBe('RECONCILIATION');
  });

  it('traduit l\'ancien format auto/manual', () => {
    expect(readOrigin({ livingArea_origin: 'auto' }, 'livingArea')).toBe('DOCUMENT_EXTRACTION');
    expect(readOrigin({ livingArea_origin: 'manual' }, 'livingArea')).toBe('USER');
  });

  it('suppose USER en l\'absence d\'information — le doute protège la donnée', () => {
    expect(readOrigin({}, 'livingArea')).toBe('USER');
    expect(readOrigin(null, 'livingArea')).toBe('USER');
    expect(isHumanOrigin(readOrigin({}, 'x'))).toBe(true);
  });

  it('ignore une valeur d\'origine inconnue et protège la donnée', () => {
    expect(readOrigin({ x__origin: 'N_IMPORTE_QUOI' }, 'x')).toBe('USER');
  });

  it('donne la priorité au format cible sur l\'ancien', () => {
    expect(readOrigin({ x__origin: 'IMPORT', x_origin: 'manual' }, 'x')).toBe('IMPORT');
  });
});

describe('écriture de l\'origine', () => {
  it('écrit le format cible et retire l\'ancien', () => {
    const out = writeOrigin({ x_origin: 'auto', autre: 1 }, 'x', 'RECONCILIATION');
    expect(out.x__origin).toBe('RECONCILIATION');
    expect(out.x_origin).toBeUndefined();
    expect(out.autre).toBe(1);
  });

  it('ne modifie pas l\'objet source', () => {
    const source = { x_origin: 'auto' };
    writeOrigin(source, 'x', 'USER');
    expect(source.x_origin).toBe('auto');
  });
});
