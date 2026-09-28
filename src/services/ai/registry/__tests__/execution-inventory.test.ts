/**
 * Inventaire d'exécution (critères n°2, 3, 24) — depuis GEN-005, le tracker
 * historique n'écrit plus « operation_complete » : les opérations de relais
 * `legacy_*` de la passerelle prouvent à leur tour qu'un moteur historique a
 * tourné.
 */
import { describe, it, expect } from 'vitest';
import { concludeExecutionInventory, isLegacyRelayOperation } from '../execution-inventory';

const row = (operationType: string, useCaseCode: string | null = 'SOURCE_ANALYSIS') => ({
  operationType, useCaseCode, events: 3, lastSeen: '2026-09-20T00:00:00Z',
});

describe('concludeExecutionInventory', () => {
  it('une opération legacy_* rend l’inventaire non conforme', () => {
    expect(isLegacyRelayOperation('legacy_document_analysis')).toBe(true);
    const c = concludeExecutionInventory([row('legacy_document_analysis')]);
    expect(c.verdict).toBe('non_conforme');
    expect(c.foreignOperations).toEqual(['legacy_document_analysis']);
    expect(c.useCasesSeen).toEqual([]);
  });

  it('les anciennes lignes hors catalogue restent une preuve', () => {
    expect(concludeExecutionInventory([row('operation_complete')]).verdict).toBe('non_conforme');
  });

  it('fenêtre vide : indéterminé', () => {
    expect(concludeExecutionInventory([]).verdict).toBe('indetermine');
  });
});
