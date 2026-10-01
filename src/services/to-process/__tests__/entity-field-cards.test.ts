/**
 * Cartes ENTITY-FIELD — conflit de champ d'un équipement (CDC 15 T1-04, lot 18).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  upsertAction: vi.fn(async (_i: unknown) => ({ status: 'CREATED' })),
  resolveActionsForData: vi.fn(async (..._a: unknown[]) => 1),
}));
vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
vi.mock('../to-process-action.service', () => m);

const { entityConflictProposals, syncEntityFieldCards } = await import('../entity-field-cards');
const { getRule, checkRulesCatalog } = await import('../rules-catalog');
import type { ReconciliationDecision } from '@/services/ai/reconciliation/types';

const decision = (over: Partial<ReconciliationDecision>): ReconciliationDecision => ({
  fieldKey: 'serialNumber', currentValue: 'MANUEL-1', proposedValue: 'SN-77', action: 'create_conflict',
  reasonCode: 'MANUAL_VALUE_CONTRADICTED', confidence: 'certain', evidenceIds: [9], deterministic: true, ...over,
});

beforeEach(() => { m.upsertAction.mockClear(); m.resolveActionsForData.mockClear(); });

describe('ENTITY-FIELD', () => {
  it('règle du catalogue : équipement, arbitrage, jamais de complétion', () => {
    expect(getRule('ENTITY-FIELD')).toMatchObject({ targetType: 'EQUIPMENT', completePriority: null });
    expect(checkRulesCatalog()).toEqual([]);
  });

  it('propositions : valeur de la preuve puis valeur en place', () => {
    expect(entityConflictProposals(decision({}))).toEqual([
      { value: 'SN-77', label: 'SN-77', confidence: 1, evidenceIds: ['9'] },
      { value: 'MANUEL-1', label: 'MANUEL-1', confidence: 1, isCurrentValue: true },
    ]);
  });

  it('conflit → carte ARBITRATE sur l’équipement ; décision tranchée → carte sans objet ; pièce : rien', async () => {
    await syncEntityFieldCards({
      accountId: 7, target: { type: 'EQUIPMENT', id: 4 }, entityName: 'Chaudière',
      decisions: [decision({}), decision({ fieldKey: 'warrantyEndDate', action: 'apply' })],
    });
    expect(m.upsertAction).toHaveBeenCalledWith(expect.objectContaining({
      targetType: 'EQUIPMENT', targetId: 4, fieldKey: 'serialNumber', actionKind: 'ARBITRATE', ruleCode: 'ENTITY-FIELD',
      triggerContext: expect.objectContaining({ key: 'serialNumber', current: 'MANUEL-1' }),
    }));
    expect((m.upsertAction.mock.calls[0][0] as { question: string }).question).toContain('Chaudière');
    expect(m.resolveActionsForData).toHaveBeenCalledWith(7, 'EQUIPMENT', 4, 'warrantyEndDate', 'OBSOLETE');

    m.upsertAction.mockClear();
    const r = await syncEntityFieldCards({ accountId: 7, target: { type: 'ROOM', id: 2 }, decisions: [decision({ fieldKey: 'roomArea' })] });
    expect(r.skipped).toBe(1);
    expect(m.upsertAction).not.toHaveBeenCalled();
  });
});
