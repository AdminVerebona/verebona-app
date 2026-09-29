/**
 * T3 sur la file durable — OPS-001, NFR-003, T3-003, T3-004, WF-10, WF-11, WF-18.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enqueueT3ForEvent, enqueueT3ForAnalyzedAsset, enqueueT3Manual, runT3Job, T3_EVENT_DELAY_SECONDS,
} from '../t3-queue';
import { NO_GUARD } from '../../queue/execution-control';
import type { QueuedJob } from '../../queue/job-queue.repository';

const enqueue = vi.fn(async (_i: unknown) => ({ decision: 'create' as const, jobId: 99 }));
const deps = (active = true) => ({ enqueue: enqueue as never, isTriggerActive: async () => active });

beforeEach(() => enqueue.mockClear());

const job = (over: Partial<QueuedJob>): QueuedJob => ({
  id: 1, treatment: 'T3', accountId: 5, targetType: null, targetId: null, status: 'RUNNING', origin: 'automatic',
  triggerCode: null, attempts: 1, lastError: null, availableAt: new Date(), coalesceRequested: false, headPriority: false,
  createdAt: new Date(), startedAt: new Date(), finishedAt: null, payload: null, executionId: null, workerId: null,
  leaseExpiresAt: null, recoveredCount: 0, configVersionId: null, ...over,
});

describe('mise en file', () => {
  it('événement à impact de cohérence : temporisé, fusionné, déclencheur du catalogue', async () => {
    const id = await enqueueT3ForEvent(5, { event: 'arbitration' }, deps(), new Date('2026-09-26T10:00:00Z'));
    expect(id).toBe(99);
    const arg = enqueue.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      treatment: 'T3', scope: { accountId: 5 }, triggerCode: 'arbitration_resolved',
      delaySeconds: T3_EVENT_DELAY_SECONDS, payloadOnDedupe: 'append_events',
    });
    expect((arg.payload as { events: unknown[] }).events).toHaveLength(1);
  });

  it('T3-004 : un événement hors catalogue ne déclenche rien', async () => {
    expect(await enqueueT3ForEvent(5, { event: 'note_edited' }, deps())).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('déclencheur inactif dans la version effective : rien', async () => {
    expect(await enqueueT3ForEvent(5, { event: 'asset_updated' }, deps(false))).toBeNull();
    expect(await enqueueT3ForAnalyzedAsset({ accountId: 5, assetId: 2, userId: 1, leadSourceId: 3 }, deps(false))).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('bien analysé : job ciblé sur le bien, le document le plus récent l’emporte', async () => {
    await enqueueT3ForAnalyzedAsset({ accountId: 5, assetId: 2, userId: 1, leadSourceId: 3 }, deps());
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      scope: { accountId: 5, targetType: 'asset', targetId: 2 }, triggerCode: 'source_analyzed', payloadOnDedupe: 'replace',
    });
  });

  it('WF-11 : lancement manuel = nouvelle exécution identifiable', async () => {
    await enqueueT3Manual(5, 8, 'full', deps());
    expect(enqueue.mock.calls[0][0]).toMatchObject({ origin: 'manual', payload: { scope: 'full', requestedByUserId: 8 } });
  });
});

describe('exécutant', () => {
  const h = () => ({
    reconcileAsset: vi.fn(async () => ({})),
    reconcileAccount: vi.fn(async () => ({ status: 'completed' })) as never,
    listSweepAccounts: vi.fn(async () => [1, 2]),
    enqueue: enqueue as never,
  });

  it('bien : réconciliation locale du moteur commun', async () => {
    const d = h();
    await runT3Job(job({ targetType: 'asset', targetId: '7', payload: { userId: 3, sourceFileId: 4 } }), NO_GUARD, d);
    expect(d.reconcileAsset).toHaveBeenCalledWith(expect.objectContaining({ accountId: 5, assetId: 7, userId: 3, sourceFileId: 4, triggeredBy: 'document_analyzed' }));
  });

  it('compte, événement : incrémental avec le dernier événement', async () => {
    const d = h();
    await runT3Job(job({ triggerCode: 'asset_updated', payload: { events: [{ event: 'asset_updated', objectId: 2 }] } }), NO_GUARD, d);
    expect((d.reconcileAccount as unknown as ReturnType<typeof vi.fn>).mock.calls[0].slice(0, 3)).toEqual([
      5, { type: 'event', event: 'asset_updated', objectType: undefined, objectId: 2, correlationId: undefined },
      expect.objectContaining({ scope: 'incremental' }),
    ]);
  });

  it('compte, manuel : périmètre complet, administrateur tracé', async () => {
    const d = h();
    await runT3Job(job({ origin: 'manual', payload: { scope: 'full', requestedByUserId: 8 } }), NO_GUARD, d);
    expect((d.reconcileAccount as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ type: 'manual', requestedByUserId: 8 });
  });

  it('balayage planifié : un job compte par compte à rationaliser', async () => {
    const d = h();
    await runT3Job(job({ accountId: null, triggerCode: 'schedule_weekly' }), NO_GUARD, d);
    expect(d.listSweepAccounts).toHaveBeenCalledWith(168);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1][0]).toMatchObject({ scope: { accountId: 2 }, triggerCode: 'schedule_weekly' });
  });

  it('exécution concurrente hors file : échec pour reprise différée (backoff), pas une clôture vide', async () => {
    const d = { ...h(), reconcileAccount: vi.fn(async () => ({ status: 'skipped_concurrent' })) as never };
    await expect(runT3Job(job({}), NO_GUARD, d)).rejects.toThrow(/déjà en cours/);
  });
});

describe('cycle de vie d’un document (CDC 15 T3-03)', () => {
  it('un travail « bien » par bien touché, déclencheur tracé document_linked', async () => {
    const { enqueueT3ForAssets } = await import('../t3-queue');
    const ids = await enqueueT3ForAssets({ accountId: 5, userId: 3, assetIds: [10, 10, 11, 0], sourceFileId: 55, reason: 'DOCUMENT_MOVED' }, deps());
    expect(ids).toEqual([99, 99]);
    expect(enqueue.mock.calls.map((c) => (c[0] as { scope: { targetId: number } }).scope.targetId)).toEqual([10, 11]);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      triggerCode: 'source_analyzed', payload: { kind: 'asset', userId: 3, sourceFileId: 55, triggeredBy: 'document_linked', lifecycleReason: 'DOCUMENT_MOVED' },
    });
    expect(await enqueueT3ForAssets({ accountId: 5, userId: 3, assetIds: [10], reason: 'x' }, deps(false))).toEqual([]);
  });

  it('exécutant : triggeredBy du cycle de vie transmis au run local', async () => {
    const reconcileAsset = vi.fn(async () => ({}));
    await runT3Job(job({ targetType: 'asset', targetId: '10', payload: { kind: 'asset', userId: 3, triggeredBy: 'document_linked' } }), NO_GUARD, {
      reconcileAsset, reconcileAccount: vi.fn() as never, listSweepAccounts: async () => [], enqueue: enqueue as never,
    });
    expect(reconcileAsset).toHaveBeenCalledWith(expect.objectContaining({ assetId: 10, triggeredBy: 'document_linked' }));
  });
});
