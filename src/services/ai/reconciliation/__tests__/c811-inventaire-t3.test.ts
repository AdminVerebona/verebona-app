/**
 * Carte #811 (P1-B) — l'inventaire anti-redondance couvre TOUTES les opérations
 * IA de T3 du registre, et seulement elles.
 */
import { describe, expect, it } from 'vitest';
import { AI_OPERATIONS } from '../../registry/operations';
import { T3_REDUNDANCY_INVENTORY } from '../t3-redundancy-inventory';

describe('C811-I01 — inventaire des opérations T3', () => {
  const registre = Object.values(AI_OPERATIONS)
    .filter((o) => o.useCaseCode === 'DATA_RECONCILIATION' && o.provider !== 'none')
    .map((o) => o.operationCode).sort();
  it('chaque opération IA de T3 du registre a son entrée (protection, clé, durée, invalidation, déclencheurs)', () => {
    expect(Object.keys(T3_REDUNDANCY_INVENTORY).sort()).toEqual(registre);
    expect(registre).toEqual([
      't3_attribute_arbitration', 't3_document_naming', 't3_economic_qualification', 't3_knowledge_query', 't3_link_ambiguity',
      't3_operation_identity', 't3_operation_match', 't3_period_relation', 't3_value_conflict',
    ]);
    for (const [code, e] of Object.entries(T3_REDUNDANCY_INVENTORY)) {
      expect(e.callSites.length, code).toBeGreaterThan(0);
      expect(e.triggers.length, code).toBeGreaterThan(0);
      for (const champ of [e.protection, e.key, e.duration, e.invalidation]) expect(champ.trim().length, code).toBeGreaterThan(10);
      expect(e.provenBy.length, `${code} : preuve de non-rappel`).toBeGreaterThan(0);
    }
  });
  it('toutes passent par la passerelle avec le prompt maître T3 (cache temporaire commun, version du prompt dans la clé)', () => {
    for (const code of registre) expect(AI_OPERATIONS[code], code).toMatchObject({ masterPromptCode: expect.any(String), active: true });
  });
});
