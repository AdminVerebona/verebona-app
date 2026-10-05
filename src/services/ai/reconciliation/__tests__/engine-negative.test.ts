/**
 * Moteur T3 — phase négative (CDC 15 T3-04), toujours active depuis le lot
 * 16b-3 (`T3_NEGATIVE_RECONCILIATION` et `AI_RECONCILIATION_ENGINE`
 * supprimés). Collecte, écriture, journal et file « À traiter » simulés.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CollectedField } from '../evidence-collector';

const h = vi.hoisted(() => ({
  state: { kc: null as Record<string, unknown> | null, fields: [] as unknown[] },
  retired: [] as Array<{ fieldKey: string; value: unknown }>,
  apply: vi.fn(async () => 'written'),
  retract: vi.fn(async () => 'written'),
  record: vi.fn(async () => {}),
  sync: vi.fn(async () => ({ created: 0, resolved: 0, skipped: 0 })),
  resolveObsolete: vi.fn(async () => {}),
}));

vi.mock('../evidence-collector', async (orig) => ({
  ...(await orig<typeof import('../evidence-collector')>()),
  collectAssetEvidenceState: async () => h.state,
}));
vi.mock('../../evidence/field-evidence.service', () => ({ listRetiredEvidenceValues: async () => h.retired }));
vi.mock('../apply-decision', () => ({ applyDecision: h.apply, retractAutomaticValue: h.retract }));
vi.mock('../conflict-writer', () => ({ writeConflict: vi.fn(), resolveObsoleteConflict: h.resolveObsolete }));
vi.mock('../reconciliation-run.repository', () => ({
  openRun: async () => 1, closeRun: async () => {}, failRun: async () => {}, recordDecisions: h.record,
}));
vi.mock('../ambiguity-resolver', () => ({ resolveAmbiguity: vi.fn() }));
vi.mock('@/services/to-process/reconciliation-bridge', () => ({ syncReconciliationToProcess: h.sync }));

import { reconcileAsset } from '../reconciliation-engine';

const stale: CollectedField = {
  fieldKey: 'acquisitionDate', unproven: true,
  input: {
    fieldKey: 'acquisitionDate', isCritical: false,
    current: { value: '2024-01-02', normalized: '2024-01-02', origin: 'RECONCILIATION', updatedAt: new Date(), authorityScore: 100, sourceDate: new Date('2030-01-01') },
    candidates: [{ evidenceId: 9, value: '2024-05-05', normalized: '2024-05-05', confidence: 'certain', authorityScore: 55, documentType: 'FACTURE', documentDate: new Date('2024-05-05'), sourceId: 3, excerpt: 'x' }],
  },
};
const kc = {
  acquisitionDate: '2024-01-02', acquisitionDate__origin: 'RECONCILIATION',
  mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION',
  insurer: 'MAIF', insurer__origin: 'USER',
};
const run = () => reconcileAsset({ accountId: 7, assetId: 1, triggeredBy: 'document_linked' });
const recorded = () => (h.record.mock.calls.at(-1) as unknown as [number, number, number, Array<{ fieldKey: string; action: string; reasonCode: string }>])[3];

beforeEach(() => {
  h.state = { kc, fields: [stale] };
  h.retired = [{ fieldKey: 'mileage', value: 1000 }, { fieldKey: 'insurer', value: 'MAIF' }];
  for (const f of [h.apply, h.retract, h.record, h.sync, h.resolveObsolete]) f.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('réconciliation négative (toujours active)', () => {
  it('meilleure preuve restante appliquée, valeur sans preuve retirée, USER intact', async () => {
    const r = await run();
    expect(r.shadow).toBe(false);
    expect(r.decisions.map((d) => [d.fieldKey, d.action, d.reasonCode])).toEqual([
      ['acquisitionDate', 'update', 'STALE_AUTO_VALUE_REPLACED'],
      ['mileage', 'update', 'NO_REMAINING_EVIDENCE'],
    ]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.retract).toHaveBeenCalledWith(expect.objectContaining({ fieldKey: 'mileage', currentValue: 1000 }));
    expect(h.retract).toHaveBeenCalledTimes(1); // jamais `insurer` (USER)
    // La file « À traiter » voit les décisions réelles ; rien d'« observé ».
    expect((h.sync.mock.calls[0] as unknown as [{ decisions: unknown[] }])[0].decisions).toHaveLength(2);
    expect(recorded().some((d) => d.reasonCode.startsWith('SHADOW_'))).toBe(false);
  });

  it('commutateur et drapeau retirés encore posés (legacy / shadow) : ignorés', async () => {
    vi.stubEnv('T3_NEGATIVE_RECONCILIATION', 'legacy');
    vi.stubEnv('AI_RECONCILIATION_ENGINE', 'shadow');
    const r = await run();
    expect(r.decisions.map((d) => d.action)).toEqual(['update', 'update']);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.retract).toHaveBeenCalledTimes(1);
  });

  it('aucun journal d’observation (« t3.negative_reconciliation ») — décisions réelles seules', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await run();
    expect(info.mock.calls.map((c) => String(c[0])).some((l) => l.includes('t3.negative_reconciliation'))).toBe(false);
  });
});
