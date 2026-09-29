/**
 * Moteur T3 — phase négative sous T3_NEGATIVE_RECONCILIATION (CDC 15 T3-04).
 * Collecte, écriture, journal et file « À traiter » simulés.
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
  engineWrites: true,
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
vi.mock('../../flags/ai-feature-flags', () => ({ shouldWrite: () => h.engineWrites }));
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
  h.engineWrites = true;
  for (const f of [h.apply, h.retract, h.record, h.sync, h.resolveObsolete]) f.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { delete process.env.T3_NEGATIVE_RECONCILIATION; });

describe('T3_NEGATIVE_RECONCILIATION', () => {
  it('legacy : comportement historique (valeur fantôme conservée, aucun retrait)', async () => {
    const r = await run();
    expect(r.decisions.map((d) => [d.fieldKey, d.action])).toEqual([['acquisitionDate', 'keep']]);
    expect(h.retract).not.toHaveBeenCalled();
    expect(recorded()).toHaveLength(1);
  });

  it('enabled : meilleure preuve restante appliquée, valeur sans preuve retirée, USER intact', async () => {
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    const r = await run();
    expect(r.decisions.map((d) => [d.fieldKey, d.action, d.reasonCode])).toEqual([
      ['acquisitionDate', 'update', 'STALE_AUTO_VALUE_REPLACED'],
      ['mileage', 'update', 'NO_REMAINING_EVIDENCE'],
    ]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.retract).toHaveBeenCalledWith(expect.objectContaining({ fieldKey: 'mileage', currentValue: 1000 }));
    expect(h.retract).toHaveBeenCalledTimes(1); // jamais `insurer` (USER)
    // La file « À traiter » voit les décisions réelles.
    expect((h.sync.mock.calls[0] as unknown as [{ decisions: unknown[] }])[0].decisions).toHaveLength(2);
  });

  it('shadow : décisions inchangées, rapport enregistré (keep motivé), rien écrit ni envoyé à « À traiter »', async () => {
    process.env.T3_NEGATIVE_RECONCILIATION = 'shadow';
    const r = await run();
    expect(r.decisions.map((d) => d.action)).toEqual(['keep']);
    expect(h.retract).not.toHaveBeenCalled();
    expect(recorded().map((d) => [d.fieldKey, d.action, d.reasonCode])).toEqual([
      ['acquisitionDate', 'keep', 'WEAKER_EVIDENCE'], // décision réelle, inchangée
      ['acquisitionDate', 'keep', 'SHADOW_WOULD_REPLACE_STALE'],
      ['mileage', 'keep', 'SHADOW_WOULD_RETRACT'],
    ]);
    expect((h.sync.mock.calls[0] as unknown as [{ decisions: unknown[] }])[0].decisions).toHaveLength(1);
  });

  it('enabled mais moteur en observation : le négatif est seulement observé', async () => {
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    h.engineWrites = false;
    await run();
    expect(h.retract).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
    expect(recorded().some((d) => d.reasonCode === 'SHADOW_WOULD_RETRACT')).toBe(true);
  });

  it('journal structuré sans aucune valeur (clés, motifs, compteurs)', async () => {
    process.env.T3_NEGATIVE_RECONCILIATION = 'shadow';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await run();
    const ligne = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('t3.negative_reconciliation'))!;
    expect(ligne).not.toMatch(/2024-01-02|1000|MAIF/);
    expect(JSON.parse(ligne).counts).toEqual({ wouldRetract: 1, wouldReplace: 1 });
  });
});
