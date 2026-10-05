/**
 * Application d'une décision T3 — CDC 15 T3-01, T3-05, T3-04 (lot 13).
 * Primitive et base simulées. Lot 16b-3 : `CANONICAL_WRITE_MODE` supprimé —
 * écriture canonique seule pour une clé du registre.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  write: vi.fn(async (_i: Record<string, unknown>) => ({ notFound: false, field: { outcome: 'written' } as Record<string, unknown> })),
  kc: {} as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  sql: [] as Array<{ sql: string; params: unknown[] }>,
  retractRows: [] as unknown[],
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/services/canonical/asset-state', () => ({
  writeCanonicalAssetField: h.write,
}));
vi.mock('@/db', () => {
  const chain = {
    from: () => chain, where: () => chain,
    limit: async () => [{ keyCharacteristics: JSON.stringify(h.kc) }],
  };
  return {
    pgClient: { unsafe: vi.fn(async (sql: string, params: unknown[]) => { h.sql.push({ sql, params }); return h.retractRows; }) },
    db: {
      select: () => chain,
      update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { h.updates.push(v); } }) }),
      insert: () => ({ values: async (v: Record<string, unknown>) => { h.inserts.push(v); } }),
    },
  };
});

import { applyDecision, retractAutomaticValue, isRegistryKey } from '../apply-decision';
import type { ReconciliationDecision } from '../types';

const decision = (over: Partial<ReconciliationDecision> = {}): ReconciliationDecision => ({
  fieldKey: 'acquisitionDate', currentValue: null, proposedValue: '2024-01-02', action: 'apply',
  reasonCode: 'EMPTY_FIELD_SINGLE_CERTAIN', confidence: 'certain', evidenceIds: [42], sourcePriority: 60, deterministic: true,
  ...over,
});
const ctx = { accountId: 7, assetId: 1, sourceFileId: 55, traceId: 'tr' };

beforeEach(() => {
  h.write.mockClear();
  h.kc = {}; h.updates = []; h.inserts = []; h.sql = []; h.retractRows = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { delete process.env.CANONICAL_WRITE_MODE; });

describe('applyDecision — écriture canonique seule (lot 16b-3)', () => {
  it('clé du registre : writeCanonicalAssetField, origine RECONCILIATION, contrôle optimiste et trace', async () => {
    expect(await applyDecision(decision(), ctx)).toBe('written');
    expect(h.write).toHaveBeenCalledWith(expect.objectContaining({
      assetId: 1, accountId: 7, key: 'acquisitionDate', value: '2024-01-02', origin: 'RECONCILIATION',
      expectedCurrent: null, source: { type: 'document', id: 55 }, traceId: 'tr',
      trace: expect.objectContaining({ evidenceId: 42, reasonCode: 'EMPTY_FIELD_SINGLE_CERTAIN', decisionType: 'apply', authority: 60 }),
    }));
    expect(h.updates).toHaveLength(0);
  });

  it('valeur humaine protégée par la primitive → rien d’autre n’est écrit', async () => {
    h.write.mockResolvedValueOnce({ notFound: false, field: { outcome: 'protected' } });
    expect(await applyDecision(decision({ action: 'update', currentValue: '2020-01-01' }), ctx)).toBe('protected');
    expect(h.updates).toHaveLength(0);
  });

  it('clé HORS registre (fait générique) : keyCharacteristics et historique', async () => {
    expect(isRegistryKey('chaudiere.puissance')).toBe(false);
    expect(await applyDecision(decision({ fieldKey: 'chaudiere.puissance', proposedValue: '24 kW' }), ctx)).toBe('written');
    expect(h.write).not.toHaveBeenCalled();
    expect(JSON.parse(h.updates[0].keyCharacteristics as string)).toMatchObject({ 'chaudiere.puissance': '24 kW', 'chaudiere.puissance__origin': 'RECONCILIATION' });
  });

  it('un commutateur retiré encore posé ne change rien : toujours la primitive', async () => {
    for (const v of ['legacy', 'shadow']) {
      process.env.CANONICAL_WRITE_MODE = v;
      h.write.mockClear();
      expect(await applyDecision(decision(), ctx)).toBe('written');
      expect(h.write).toHaveBeenCalledTimes(1);
      expect(h.updates).toHaveLength(0);
    }
  });

  it('relecture de sécurité (clé hors registre) : valeur changée entre-temps → rien', async () => {
    h.kc = { 'x.y': 'autre' };
    expect(await applyDecision(decision({ fieldKey: 'x.y', proposedValue: 'v' }), ctx)).toBe('conflict');
    expect(h.updates).toHaveLength(0);
  });

  it('champ de saisie seule (D-D) : jamais écrit par T3', async () => {
    expect(await applyDecision(decision({ fieldKey: 'surfaceAnnoncee' }), ctx)).toBe('skipped');
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe('retractAutomaticValue (T3-04)', () => {
  it('clé du registre : primitive, valeur null, motif NO_REMAINING_EVIDENCE', async () => {
    await retractAutomaticValue({ accountId: 7, assetId: 1, fieldKey: 'acquisitionDate', currentValue: '2024-01-02', traceId: 'tr' });
    expect(h.write).toHaveBeenCalledWith(expect.objectContaining({
      key: 'acquisitionDate', value: null, origin: 'RECONCILIATION', expectedCurrent: '2024-01-02',
      trace: expect.objectContaining({ reasonCode: 'NO_REMAINING_EVIDENCE' }),
    }));
  });

  it('clé hors registre : mise à jour CIBLÉE atomique (valeur et origine vérifiées par SQL) + historique', async () => {
    h.retractRows = [{ id: 1 }];
    expect(await retractAutomaticValue({ accountId: 7, assetId: 1, fieldKey: 'x.y', currentValue: 'a' })).toBe('written');
    const q = h.sql[0];
    expect(q.sql).toMatch(/- \$3::text - \(\$3::text \|\| '__authority'\)/);
    expect(q.sql).toMatch(/jsonb_build_object\(\$3::text \|\| '__origin', 'RECONCILIATION'/);
    expect(q.sql).toMatch(/-> \$3::text\) = \$4::jsonb/);
    expect(q.sql).toMatch(/IN \('DOCUMENT_EXTRACTION', 'RECONCILIATION'\)/);
    expect(q.params.slice(0, 4)).toEqual([1, 7, 'x.y', JSON.stringify('a')]);
    expect(h.updates).toHaveLength(0); // jamais le JSON entier réécrit
    expect(h.inserts[0]).toMatchObject({ fieldKey: 'x.y', oldValue: 'a', newValue: '', reasonCode: 'NO_REMAINING_EVIDENCE' });
  });

  it('clé hors registre, rien retiré : protégée (humaine) ou modifiée entre-temps', async () => {
    h.kc = { 'x.y': 'a', 'x.y__origin': 'USER' };
    expect(await retractAutomaticValue({ accountId: 7, assetId: 1, fieldKey: 'x.y', currentValue: 'a' })).toBe('protected');
    h.kc = { 'x.y': 'b', 'x.y__origin': 'RECONCILIATION' };
    expect(await retractAutomaticValue({ accountId: 7, assetId: 1, fieldKey: 'x.y', currentValue: 'a' })).toBe('conflict');
    expect(h.inserts).toHaveLength(0);
  });
});
