/**
 * T4 sur la file durable — OPS-001, NFR-003, T4-016, WF-07.
 */
import { describe, it, expect, vi } from 'vitest';
import { enqueueT4Candidates, runT4Job } from '../index';
import { NO_GUARD, ExecutionCancelledError } from '../../queue/execution-control';
import type { QueuedJob } from '../../queue/job-queue.repository';

const candidat = { title: 'Contrôle technique', date: '2027-01-10', confidence: 'HIGH', excerpt: '…' } as never;
const job = (payload: Record<string, unknown> | null): QueuedJob => ({
  id: 1, treatment: 'T4', accountId: 5, targetType: 'asset_file', targetId: '3', status: 'RUNNING', origin: 'automatic',
  triggerCode: 'source_analyzed', attempts: 1, lastError: null, availableAt: new Date(), coalesceRequested: false,
  headPriority: false, createdAt: new Date(), startedAt: new Date(), finishedAt: null, payload, executionId: null,
  workerId: null, leaseExpiresAt: null, recoveredCount: 0, configVersionId: null,
});

describe('mise en file des candidats', () => {
  it('job par document source, candidats portés, les plus récents remplacent', async () => {
    const enqueue = vi.fn(async (_i: unknown) => ({ decision: 'create' as const, jobId: 4 }));
    const id = await enqueueT4Candidates(
      { accountId: 5, userId: 1, assetId: 2, leadSourceId: 3, candidates: [candidat] },
      { enqueue: enqueue as never, isTriggerActive: async () => true },
    );
    expect(id).toBe(4);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      treatment: 'T4', scope: { accountId: 5, targetType: 'asset_file', targetId: 3 },
      payload: { assetId: 2, userId: 1, leadSourceId: 3, candidates: [candidat] }, payloadOnDedupe: 'replace',
    });
  });
  it('déclencheur inactif : rien', async () => {
    const enqueue = vi.fn();
    expect(await enqueueT4Candidates(
      { accountId: 5, userId: 1, assetId: 2, leadSourceId: 3, candidates: [candidat] },
      { enqueue: enqueue as never, isTriggerActive: async () => false },
    )).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('exécutant', () => {
  const deps = (write = true) => ({
    loadExisting: vi.fn(async () => []),
    persist: vi.fn(async () => {}),
    process: vi.fn(async () => [{ action: 'create' }]) as never,
    shouldWrite: () => write,
  });

  it('décide puis écrit', async () => {
    const d = deps();
    await runT4Job(job({ assetId: 2, userId: 1, leadSourceId: 3, candidates: [candidat] }), NO_GUARD, d);
    expect(d.loadExisting).toHaveBeenCalledWith(5, 2);
    expect(d.persist).toHaveBeenCalledWith([{ action: 'create' }], 5, 2);
  });
  it('mode observation : rien n’est écrit', async () => {
    const d = deps(false);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await runT4Job(job({ assetId: 2, userId: 1, leadSourceId: 3, candidates: [candidat] }), NO_GUARD, d);
    expect(d.persist).not.toHaveBeenCalled();
  });
  it('interrompu (rollback, arrêt d’urgence) : aucune écriture', async () => {
    const d = deps();
    const guard = { ...NO_GUARD, assertActive: async () => { throw new ExecutionCancelledError('test'); } };
    await expect(runT4Job(job({ assetId: 2, userId: 1, leadSourceId: 3, candidates: [candidat] }), guard, d)).rejects.toThrow();
    expect(d.persist).not.toHaveBeenCalled();
  });
  it('contexte malformé : ignoré sans relance', async () => {
    const d = deps();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runT4Job(job(null), NO_GUARD, d);
    expect(d.process).not.toHaveBeenCalled();
  });
});
