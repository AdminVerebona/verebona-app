/**
 * Gardes de cycle de vie — VER-002 (un seul À tester, refus explicite),
 * WF-27 (Brouillon obsolète : pas de promotion silencieuse ; marquage à
 * l'activation et au rollback), VER-020 (dernier rollback viable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyTreatmentConfig } from '../config-types';

const repo = {
  getVersion: vi.fn(),
  getActiveVersion: vi.fn(async () => null),
  listVersions: vi.fn(async () => [] as unknown[]),
  promoteToTest: vi.fn(async () => 'TO_TEST'),
  switchActive: vi.fn(async () => ({ previousId: 4 })),
  markStaleDrafts: vi.fn(async () => 1),
  archiveVersion: vi.fn(async () => 'ARCHIVED'),
};
vi.mock('../config-version.repository', () => repo);
vi.mock('../config-resolver', () => ({ invalidateConfigCache: () => {} }));
vi.mock('../../telemetry/execution-context', () => ({ invalidateConfigVersionCache: () => {} }));
vi.mock('../../queue/job-queue.repository', () => ({ requeueRunning: async () => 0 }));

const { promote, activate, rollback, archive, isLastRollbackPoint, ConfigOperationRefused } = await import('../config-version.service');

const draft = (over: Record<string, unknown> = {}) => ({
  id: 7, status: 'DRAFT', environment: 'local', isStale: false, label: 'b', activatedAt: null,
  entries: [{ ...emptyTreatmentConfig('T1'), prompt: 'x' }], ...over,
});

beforeEach(() => {
  for (const f of Object.values(repo)) f.mockClear();
  repo.listVersions.mockResolvedValue([]);
});

describe('promotion', () => {
  it('VER-002 : une autre version À tester → refus explicite TO_TEST_EXISTS, rien d’écrit', async () => {
    repo.getVersion.mockResolvedValue(draft());
    repo.listVersions.mockResolvedValue([{ id: 3, status: 'TO_TEST', label: 'ancienne' }]);
    await expect(promote(7)).rejects.toMatchObject({ code: 'TO_TEST_EXISTS', details: { id: 3 } });
    expect(repo.promoteToTest).not.toHaveBeenCalled();
  });

  it('WF-27 : Brouillon obsolète refusé sans acquittement du diff', async () => {
    repo.getVersion.mockResolvedValue(draft({ isStale: true }));
    await expect(promote(7)).rejects.toBeInstanceOf(ConfigOperationRefused);
    await expect(promote(7)).rejects.toMatchObject({ code: 'STALE_DRAFT' });
    expect(repo.promoteToTest).not.toHaveBeenCalled();
  });
});

describe('obsolescence à la bascule (WF-27)', () => {
  it('activation et rollback marquent les Brouillons de l’Active remplacée', async () => {
    await activate(8, 1);
    expect(repo.markStaleDrafts).toHaveBeenCalledWith(4);
    repo.getVersion.mockResolvedValue(draft({ status: 'VALIDATED', activatedAt: new Date() }));
    await rollback(8, 1);
    expect(repo.markStaleDrafts).toHaveBeenCalledTimes(2);
  });
});

describe('archivage (VER-020)', () => {
  const v = (id: number, status: string, activatedAt: Date | null) => ({ id, status, activatedAt });
  it('le seul rollback viable ne s’archive pas', async () => {
    const versions = [v(1, 'ACTIVE', new Date()), v(2, 'VALIDATED', new Date()), v(3, 'VALIDATED', null)];
    expect(isLastRollbackPoint(2, versions as never)).toBe(true);
    expect(isLastRollbackPoint(3, versions as never)).toBe(false);
    repo.listVersions.mockResolvedValue(versions);
    await expect(archive(2)).rejects.toMatchObject({ code: 'LAST_ROLLBACK' });
    expect(repo.archiveVersion).not.toHaveBeenCalled();
  });
  it('avec un autre rollback viable, l’archivage passe', async () => {
    repo.listVersions.mockResolvedValue([v(2, 'VALIDATED', new Date()), v(5, 'VALIDATED', new Date())]);
    await archive(2);
    expect(repo.archiveVersion).toHaveBeenCalledWith(2);
  });
});
