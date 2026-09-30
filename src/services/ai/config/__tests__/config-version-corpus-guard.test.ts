/**
 * CDC 15 §30, D-17 — la garde du corpus des masters s'applique à CHAQUE
 * passage à ACTIVE (validation d'une « À tester », activation, restauration),
 * AVANT toute transition. Aucun contournement.
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
vi.mock('../../governance/master-corpus/activation-guard', () => ({ checkMasterActivation: (v: unknown) => gate(v) }));
const audit = vi.fn(async (_t: unknown) => {});
vi.mock('../rollback-override.audit', () => ({ recordRollbackOverride: (t: unknown) => audit(t) }));

const { validate, activate, rollback, ConfigOperationRefused } = await import('../config-version.service');

const version = (over: Record<string, unknown> = {}) => ({
  id: 9, status: 'TO_TEST', environment: 'local', isStale: false, label: 'm', activatedAt: new Date(),
  entries: [{ ...emptyTreatmentConfig('T1'), promptArchitecture: 'master' }], ...over,
});
const refus = { allowed: false, entries: [{ treatment: 'T1', status: 'NO_RUN', message: 'T1 : aucun corpus exécuté pour t1_master_v1.' }] };

beforeEach(() => {
  for (const f of Object.values(repo)) f.mockClear();
  gate.mockReset();
  audit.mockClear();
});

describe('garde du corpus des masters', () => {
  it('validation et activation refusées sans corpus vert — aucune transition, aucun contournement', async () => {
    gate.mockResolvedValue(refus);
    for (const [fn, status] of [[validate, 'TO_TEST'], [activate, 'VALIDATED']] as const) {
      repo.getVersion.mockResolvedValue(version({ status }));
      const e = await fn(9, 1).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigOperationRefused);
      expect(e).toMatchObject({ code: 'MASTER_CORPUS_NOT_GREEN', message: expect.stringMatching(/aucun corpus exécuté/) });
      expect((e as { details: { entries: unknown[] } }).details.entries).toEqual(refus.entries);
    }
    expect(repo.validateVersion).not.toHaveBeenCalled();
    expect(repo.switchActive).not.toHaveBeenCalled();
  });

  it('restauration d’urgence : jamais bloquée, mais justification obligatoire et tracée (qui, pourquoi, corpus)', async () => {
    gate.mockResolvedValue(refus);
    repo.getVersion.mockResolvedValue(version({ status: 'VALIDATED' }));
    const sans = await rollback(9, 1).then(() => null, (x: unknown) => x);
    expect(sans).toMatchObject({ code: 'ROLLBACK_JUSTIFICATION_REQUIRED' });
    expect(repo.switchActive).not.toHaveBeenCalled();
    const r = await rollback(9, 1, { justification: 'Incident prod : T1 renvoie des titres vides depuis 10h' });
    expect(r).toMatchObject({ interrupts: true, corpusOverride: true });
    expect(repo.switchActive).toHaveBeenCalledWith(9, 1, 'rollback');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      adminUserId: 1, versionId: 9, justification: 'Incident prod : T1 renvoie des titres vides depuis 10h', corpus: refus.entries,
    }));
  });

  it('corpus vert : transitions sans justification ; lecture impossible : refus explicite', async () => {
    gate.mockResolvedValue({ allowed: true, entries: [] });
    repo.getVersion.mockResolvedValue(version({ status: 'VALIDATED' }));
    await activate(9, 1);
    expect(repo.switchActive).toHaveBeenCalledWith(9, 1, 'activate');
    expect(await rollback(9, 1)).toMatchObject({ corpusOverride: false });
    expect(audit).not.toHaveBeenCalled();
    repo.getVersion.mockResolvedValue(version());
    await validate(9, 1);
    expect(repo.validateVersion).toHaveBeenCalled();
    gate.mockRejectedValue(new Error('master t1_master_v1 introuvable'));
    repo.getVersion.mockResolvedValue(version({ status: 'VALIDATED' }));
    await expect(activate(9, 1)).rejects.toMatchObject({ code: 'MASTER_CORPUS_CHECK_FAILED', message: expect.stringMatching(/introuvable/) });
  });
});
