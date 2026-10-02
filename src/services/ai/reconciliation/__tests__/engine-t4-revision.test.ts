/**
 * Moteur T3 du BIEN — décision PO D-M (lot 20) : une preuve révisée par une
 * date tranchée par T4 corrige la valeur automatique qu'elle remplace, quel
 * que soit T3_NEGATIVE_RECONCILIATION ; jamais une valeur USER/ADMIN.
 * Collecte, écriture, journal et file « À traiter » simulés.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CollectedField } from '../evidence-collector';

const h = vi.hoisted(() => ({
  state: { kc: null as Record<string, unknown> | null, fields: [] as unknown[] },
  apply: vi.fn(async () => 'written'),
  record: vi.fn(async () => {}),
}));

vi.mock('../evidence-collector', async (orig) => ({
  ...(await orig<typeof import('../evidence-collector')>()),
  collectAssetEvidenceState: async () => h.state,
}));
vi.mock('../../evidence/field-evidence.service', () => ({ listRetiredEvidenceValues: async () => [] }));
vi.mock('../apply-decision', () => ({ applyDecision: h.apply, retractAutomaticValue: vi.fn(async () => 'written') }));
vi.mock('../conflict-writer', () => ({ writeConflict: vi.fn(), resolveObsoleteConflict: vi.fn(async () => {}) }));
vi.mock('../reconciliation-run.repository', () => ({
  openRun: async () => 1, closeRun: async () => {}, failRun: async () => {}, recordDecisions: h.record,
}));
vi.mock('../ambiguity-resolver', () => ({ resolveAmbiguity: vi.fn() }));
vi.mock('../../flags/ai-feature-flags', () => ({ shouldWrite: () => true }));
vi.mock('@/services/to-process/reconciliation-bridge', () => ({ syncReconciliationToProcess: vi.fn(async () => ({})) }));

import { reconcileAsset } from '../reconciliation-engine';

const DOC = new Date('2026-03-04');
const champ = (origin: 'RECONCILIATION' | 'USER', projectionRule?: string): CollectedField => ({
  fieldKey: 'nextInspection', unproven: origin === 'RECONCILIATION',
  input: {
    fieldKey: 'nextInspection', isCritical: false,
    current: { value: '2027-03-04', normalized: '2027-03-04', origin, updatedAt: DOC, authorityScore: 90, sourceDate: DOC },
    candidates: [{
      evidenceId: 71, value: '2027-04-03', normalized: '2027-04-03', confidence: 'certain', authorityScore: 90,
      documentType: 'CONTROLE_TECHNIQUE', documentDate: DOC, sourceId: 40, excerpt: 'avant le 03/04/2027',
      ...(projectionRule ? { projectionRule } : {}),
    }],
  },
});
const run = () => reconcileAsset({ accountId: 7, assetId: 1, triggeredBy: 'document_linked' });

beforeEach(() => {
  h.apply.mockClear();
  h.record.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { delete process.env.T3_NEGATIVE_RECONCILIATION; });

describe('D-M — bien', () => {
  it('négatif legacy : preuve révisée → mise à jour T4_DATE_REVISED, appliquée par la primitive (applyDecision)', async () => {
    h.state = { kc: { nextInspection: '2027-03-04', nextInspection__origin: 'RECONCILIATION' }, fields: [champ('RECONCILIATION', 'T4_TEMPORAL_RESOLUTION')] };
    const r = await run();
    expect(r.decisions.map((d) => [d.fieldKey, d.action, d.reasonCode, d.proposedValue])).toEqual([
      ['nextInspection', 'update', 'T4_DATE_REVISED', '2027-04-03'],
    ]);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('sans révision T4 (même autorité, même date) : conflit, comportement inchangé', async () => {
    h.state = { kc: { nextInspection: '2027-03-04', nextInspection__origin: 'RECONCILIATION' }, fields: [champ('RECONCILIATION')] };
    const r = await run();
    expect(r.decisions[0]).toMatchObject({ action: 'create_conflict' });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('valeur USER : jamais remplacée, même par une preuve révisée', async () => {
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    h.state = { kc: { nextInspection: '2027-03-04', nextInspection__origin: 'USER' }, fields: [champ('USER', 'T4_TEMPORAL_RESOLUTION')] };
    const r = await run();
    expect(r.decisions[0]).toMatchObject({ action: 'create_conflict', reasonCode: 'MANUAL_VALUE_CONTRADICTED' });
    expect(h.apply).not.toHaveBeenCalled();
  });
});
