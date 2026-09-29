/**
 * CDC 15 X-03 — règles « À traiter » sur les clés canoniques du registre.
 * Recette : un conflit sur `acquisitionPrice` crée exactement une carte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  upsert: vi.fn(async (_i: Record<string, unknown>) => ({ status: 'CREATED' })),
  resolve: vi.fn(async () => 1),
}));
vi.mock('../to-process-action.service', () => ({ upsertAction: h.upsert, resolveActionsForData: h.resolve }));

import { findRule, PROCESSING_RULES } from '../rules-catalog';
import { mapReconciliationDecision, syncReconciliationToProcess } from '../reconciliation-bridge';
import { getField } from '@/services/canonical/registry';
import type { ReconciliationDecision } from '@/services/ai/reconciliation/types';

const d = (over: Partial<ReconciliationDecision>): ReconciliationDecision => ({
  fieldKey: 'acquisitionPrice', currentValue: 700, proposedValue: 749, action: 'create_conflict',
  reasonCode: 'MANUAL_VALUE_CONTRADICTED', confidence: 'certain', evidenceIds: [1], deterministic: true, ...over,
});

beforeEach(() => { h.upsert.mockClear(); h.resolve.mockClear(); });

describe('catalogue', () => {
  it('toute règle de BIEN porte une clé canonique du registre', () => {
    for (const r of PROCESSING_RULES.filter((x) => x.targetType === 'ASSET' && x.fieldKey)) {
      expect(getField(r.fieldKey!), r.code).toBeDefined();
    }
  });

  it('alias résolus vers la règle canonique', () => {
    for (const k of ['acquisitionPrice', 'purchasePriceCents', 'prixAchat', 'purchasePrice']) {
      expect(findRule('ASSET', k)?.code, k).toBe('DATA-ACQUISITION-PRICE');
    }
    expect(findRule('ASSET', 'immatriculation')?.code).toBe('DATA-REGISTRATION');
  });
});

describe('pont réconciliation → « À traiter »', () => {
  it('la carte porte la clé canonique, jamais l’alias de la preuve', () => {
    expect(mapReconciliationDecision(d({ fieldKey: 'purchasePriceCents' }))).toMatchObject({ kind: 'UPSERT', fieldKey: 'acquisitionPrice', ruleCode: 'DATA-ACQUISITION-PRICE' });
  });

  it('conflit sur acquisitionPrice : exactement UNE carte, pas refermée par la décision d’un alias', async () => {
    const r = await syncReconciliationToProcess({
      accountId: 1, assetId: 2,
      decisions: [d({}), d({ fieldKey: 'prixAchat' }), d({ fieldKey: 'purchasePriceCents', action: 'keep', reasonCode: 'AUTO_VALUE_CONFIRMED' })],
    });
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert.mock.calls[0][0]).toMatchObject({ fieldKey: 'acquisitionPrice', actionKind: 'ARBITRATE' });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(r.created).toBe(1);
  });
});

describe('resolveActionsForData — clé canonique ET alias (relecture lot 13)', () => {
  it('une donnée de bien est fermée sous toutes ses clés', async () => {
    const { assetKeyVariants } = await vi.importActual<typeof import('../to-process-action.service')>('../to-process-action.service');
    const v = assetKeyVariants('acquisitionPrice');
    expect(v).toEqual(expect.arrayContaining(['acquisitionPrice', 'purchasePriceCents', 'prixAchat']));
    expect(assetKeyVariants('purchasePriceCents')).toEqual(expect.arrayContaining(['purchasePriceCents', 'acquisitionPrice']));
    expect(assetKeyVariants('cleInconnue')).toEqual(['cleInconnue']);
  });
});
