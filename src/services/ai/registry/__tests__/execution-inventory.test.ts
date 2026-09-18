/**
 * CDC §12, critères n°1, 2, 3 et 24 — verdict de l'inventaire d'exécution.
 *
 * C'est cette règle qui autorise ou refuse la bascule réglementaire de onze
 * usages à cinq. Elle doit tenir sur trois propriétés :
 *   · une opération hors référentiel prouve qu'un moteur historique a tourné ;
 *   · un `use_case_code` cible ne prouve RIEN, puisque le tracker historique
 *     en estampille lui aussi ses écritures ;
 *   · une fenêtre vide ne conclut pas.
 */
import { describe, it, expect } from 'vitest';
import {
  concludeExecutionInventory, knownOperationCodes,
  type ObservedOperation,
} from '../execution-inventory';

const DERNIER = '2026-09-01T10:00:00.000Z';

function ligne(operationType: string, useCaseCode: string | null, events = 10): ObservedOperation {
  return { operationType, useCaseCode, events, lastSeen: DERNIER };
}

/** Une opération réellement présente au référentiel, quelle qu'elle soit. */
const OP_CONNUE = [...knownOperationCodes()][0];

describe('une fenêtre vide ne conclut pas', () => {
  it('rend « indéterminé », jamais « conforme »', () => {
    // Le piège à éviter : un rapport vide présenté comme une preuve
    // d'extinction. L'absence de preuve n'est pas une preuve d'absence.
    const c = concludeExecutionInventory([]);
    expect(c.verdict).toBe('indetermine');
    expect(c.totalEvents).toBe(0);
  });

  it('rend « indéterminé » aussi si toutes les lignes sont à zéro appel', () => {
    const c = concludeExecutionInventory([ligne(OP_CONNUE, 'SOURCE_ANALYSIS', 0)]);
    expect(c.verdict).toBe('indetermine');
  });
});

describe('le verdict porte sur les opérations, pas sur les usages', () => {
  it('refuse dès qu’une opération sort du référentiel', () => {
    const c = concludeExecutionInventory([
      ligne(OP_CONNUE, 'SOURCE_ANALYSIS', 120),
      ligne('operation_complete', 'SOURCE_ANALYSIS', 4),
    ]);
    expect(c.verdict).toBe('non_conforme');
    expect(c.foreignOperations).toEqual(['operation_complete']);
  });

  it("ne se laisse pas tromper par un use_case_code cible sur une écriture historique", () => {
    // Le cœur du critère n°24. `ai-usage-tracker.ts` estampille ses écritures
    // avec `resolveLegacyUseCase()` : le code d'usage est donc l'un des cinq,
    // alors que le moteur qui a écrit est historique. Un verdict fondé sur
    // `use_case_code` conclurait ici à la conformité.
    const c = concludeExecutionInventory([
      ligne('document_analysis', 'SOURCE_ANALYSIS', 900),
      ligne('asset_suggestion', 'DATA_RECONCILIATION', 300),
    ]);
    expect(c.verdict).toBe('non_conforme');
    expect(c.foreignOperations).toEqual(['asset_suggestion', 'document_analysis']);
    // Aucun usage n'est porté au crédit du référentiel : ces lignes ne
    // viennent pas de la gateway.
    expect(c.useCasesSeen).toEqual([]);
  });

  it('accepte quand toutes les opérations appartiennent au référentiel', () => {
    const connues = [...knownOperationCodes()].slice(0, 3);
    const c = concludeExecutionInventory(
      connues.map((op, i) => ligne(op, i === 0 ? 'SOURCE_ANALYSIS' : 'INTELLIGENT_ASSISTANT', 50)),
    );
    expect(c.verdict).toBe('conforme');
    expect(c.foreignOperations).toEqual([]);
    expect(c.useCasesSeen).toContain('SOURCE_ANALYSIS');
  });
});

describe('restitution', () => {
  it('additionne les appels de toutes les lignes', () => {
    const c = concludeExecutionInventory([
      ligne(OP_CONNUE, 'SOURCE_ANALYSIS', 7),
      ligne('legacy_op', 'SOURCE_ANALYSIS', 3),
    ]);
    expect(c.totalEvents).toBe(10);
  });

  it('dédoublonne et trie les opérations étrangères', () => {
    const c = concludeExecutionInventory([
      ligne('zeta_legacy', 'SOURCE_ANALYSIS', 1),
      ligne('alpha_legacy', null, 1),
      ligne('zeta_legacy', 'AGENDA_INTELLIGENCE', 1),
    ]);
    expect(c.foreignOperations).toEqual(['alpha_legacy', 'zeta_legacy']);
  });

  it('énonce toujours un motif exploitable en recette', () => {
    for (const rows of [[], [ligne('legacy_op', null, 5)], [ligne(OP_CONNUE, 'SOURCE_ANALYSIS', 5)]]) {
      expect(concludeExecutionInventory(rows).reason.length).toBeGreaterThan(20);
    }
  });
});
