/**
 * BO-IA-PROMPTS-01 — le corpus des masters N'EST PLUS une garde des versions
 * de configuration : validation d'une « À tester », activation et
 * restauration passent sans corpus, avec un corpus rouge, et sans
 * justification. Le module du corpus n'est même plus consulté.
 * (Avant le lot 27 : CDC 15 §30, D-17 — refus `MASTER_CORPUS_NOT_GREEN`.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyTreatmentConfig } from '../config-types';

const repo = {
  getVersion: vi.fn(),
  getActiveVersion: vi.fn(async () => null),
  listVersions: vi.fn(async () => [] as unknown[]),
  validateVersion: vi.fn(async () => ({ status: 'ACTIVE', visibleNumber: 5 })),
  switchActive: vi.fn(async () => ({ previousId: 4 })),
  markStaleDrafts: vi.fn(async () => 1),
};
const gate = vi.fn();
vi.mock('../config-version.repository', () => repo);
vi.mock('../config-resolver', () => ({ invalidateConfigCache: () => {} }));
vi.mock('../../telemetry/execution-context', () => ({ invalidateConfigVersionCache: () => {} }));
vi.mock('../../queue/job-queue.repository', () => ({ requeueRunning: async () => 0 }));
vi.mock('../config-validation.service', () => ({ validateVersion: () => ({ valid: true, issues: [] }) }));
vi.mock('../../gateway/pricing/gemini-public-catalog', () => ({ GEMINI_PUBLIC_CATALOG: [] }));
vi.mock('../../gateway/pricing/pricing.repository', () => ({
  getCachedPrice: () => null, loadPricingCache: async () => {}, getCacheState: () => ({ loadedAt: 1 }),
}));
vi.mock('../../provider/model-catalog.service', () => ({ getCatalogState: async () => ({ refreshedAt: null, models: [] }), selectableModels: () => [] }));
// Si le service consultait encore la garde, ce mock le révélerait.
vi.mock('../../governance/master-corpus/activation-guard', () => ({ checkMasterActivation: (v: unknown) => gate(v) }));

const { validate, activate, rollback } = await import('../config-version.service');

const version = (over: Record<string, unknown> = {}) => ({
  id: 9, status: 'TO_TEST', environment: 'local', isStale: false, label: 'm', activatedAt: new Date(),
  entries: (['T1', 'T2', 'T3', 'T4', 'T5', 'T6'] as const).map((t) => ({ ...emptyTreatmentConfig(t), promptArchitecture: 'master' })),
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(repo)) f.mockClear();
  gate.mockReset();
  gate.mockResolvedValue({ allowed: false, entries: [{ treatment: 'T1', status: 'NO_RUN', message: 'aucun corpus' }] });
});

describe('BO-IA-PROMPTS-01 — versions de configuration sans garde du corpus', () => {
  it('AC04 — validation et activation sans aucun corpus enregistré : la transition a lieu', async () => {
    repo.getVersion.mockResolvedValue(version({ status: 'TO_TEST' }));
    await expect(validate(9, 1)).resolves.toMatchObject({ visibleNumber: 5 });
    repo.getVersion.mockResolvedValue(version({ status: 'VALIDATED' }));
    await expect(activate(9, 1)).resolves.toMatchObject({ previousId: 4, interrupts: false });
    expect(repo.validateVersion).toHaveBeenCalledWith(9, 1);
    expect(repo.switchActive).toHaveBeenCalledWith(9, 1, 'activate');
    expect(gate).not.toHaveBeenCalled();
  });

  it('AC05 / AC06 — corpus rouge sur T1 (et T3, T4…) : l’activation globale n’est pas bloquée', async () => {
    gate.mockResolvedValue({ allowed: false, entries: ['T1', 'T3', 'T4', 'T6'].map((t) => ({ treatment: t, status: 'RUN_FAILED' })) });
    repo.getVersion.mockResolvedValue(version({ status: 'VALIDATED' }));
    await expect(activate(9, 1)).resolves.toMatchObject({ interrupts: false });
    expect(gate).not.toHaveBeenCalled();
  });

  it('AC11 — restauration sans justification ni corpus : bascule, interruption et remise en file', async () => {
    repo.getVersion.mockResolvedValue(version({ status: 'VALIDATED' }));
    const r = await rollback(9, 1);
    expect(r).toMatchObject({ interrupts: true, previousId: 4 });
    expect(r).not.toHaveProperty('corpusOverride');
    expect(repo.switchActive).toHaveBeenCalledWith(9, 1, 'rollback');
    expect(gate).not.toHaveBeenCalled();
  });

  it('AC09 — une version jamais active ne se « restaure » pas (contrôle conservé)', async () => {
    repo.getVersion.mockResolvedValue(version({ status: 'VALIDATED', activatedAt: null }));
    await expect(rollback(9, 1)).rejects.toMatchObject({ code: 'NEVER_ACTIVE' });
    expect(repo.switchActive).not.toHaveBeenCalled();
  });
});
