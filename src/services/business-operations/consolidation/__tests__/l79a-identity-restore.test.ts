/**
 * Lot 79A — rétablissement BO d'une séparation d'identité (règles pures).
 *
 *   · L79A-S01 contradiction d'attribut ARBITRÉE seulement si, sans les
 *     sources rétablies au BO, il ne reste qu'une valeur ;
 *   · L79A-S02 prédicat « séparation encore effective » unique (bouton BO et
 *     contrôle sous verrou) : tous les cas de refus du ticket couverts.
 */
import { describe, expect, it } from 'vitest';
import { RESTORE_BLOCK_SQL, splitArbitratedConflicts } from '../identity-review';
import { RESTORE_BLOCK_MESSAGES, restoreBlockStatus } from '../../identity-restore.model';

const conflit = (field: string, ...values: Array<[string, number[]]>) => ({ field, values: values.map(([value, sourceIds]) => ({ value, sourceIds })), retained: values[0][0] });

describe('L79A-S01 contradictions arbitrées par un rétablissement BO', () => {
  it('fondatrice contre source rétablie seule → arbitrée ; aucune source rétablie → inchangé', () => {
    const c = conflit('realizedDate', ['2025-05-12', [1]], ['2021-06-30', [3]]);
    expect(splitArbitratedConflicts([c], new Set([3]))).toEqual({ open: [], arbitrated: [c] });
    expect(splitArbitratedConflicts([c], new Set())).toEqual({ open: [c], arbitrated: [] });
  });
  it('une troisième source NON rétablie qui contredit encore → reste à examiner', () => {
    const c = conflit('provider', ['Tikamoon', [1]], ['Office notarial', [3]], ['Agence', [4]]);
    expect(splitArbitratedConflicts([c], new Set([3]))).toEqual({ open: [c], arbitrated: [] });
  });
  it('valeur portée à la fois par une source rétablie et une autre : comptée', () => {
    const c = conflit('provider', ['Tikamoon', [1]], ['Office notarial', [3, 4]]);
    expect(splitArbitratedConflicts([c], new Set([3])).open).toEqual([c]);
  });
});

describe('L79A-S02 prédicat « séparation encore effective »', () => {
  it('chaque refus du ticket a un code SQL, un message clair et un statut HTTP', () => {
    for (const code of ['NOT_A_SEPARATION', 'ALREADY_RESTORED', 'SOURCE_DELETED', 'CANDIDATE_GONE', 'ORIGIN_MERGED', 'ORIGIN_INVALIDATED', 'ALREADY_ATTACHED'] as const) {
      expect(RESTORE_BLOCK_SQL).toContain(`'${code}'`);
      expect(RESTORE_BLOCK_MESSAGES[code].length).toBeGreaterThan(10);
      expect(restoreBlockStatus(code)).toBe(409);
    }
    expect(restoreBlockStatus('NOT_FOUND')).toBe(404);
    // Bornage par compte dans chaque sous-requête.
    expect(RESTORE_BLOCK_SQL.match(/account_id = r\.account_id/g)?.length).toBe(3);
  });
});
