/**
 * Lot 31B au contrat de file T3 du lot 31C : sortes de travail
 * `document_asset` / `document_asset_sweep` enregistrées, contexte versionné,
 * `PermanentJobError`, résultat métier, rattrapage paginé, abonné
 * `source_analyzed`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  handler: null as unknown,
  sub: null as null | ((e: unknown) => Promise<void>),
  starters: new Map<string, (ctx: unknown) => Promise<void>>(),
  enqueueT3ForAnalyzedAsset: vi.fn(async () => 1),
  resolve: vi.fn(async () => ({ outcome: 'APPLIED', status: 'RESOLVED', aiCalled: false, decision: { kind: 'APPLY', assetId: 4, score: 1, reason: 'x', method: 'DETERMINISTIC' } })),
  markPending: vi.fn(async () => {}),
}));

vi.mock('../../../queue/queue-worker', () => ({ registerJobHandler: (_t: string, h: unknown) => { m.handler = h; } }));
vi.mock('../../../source-analysis/events', () => ({ onSourceAnalyzed: (_l: string, h: typeof m.sub) => { m.sub = h; } }));
vi.mock('../../t3-queue', async (orig) => ({
  ...(await orig<typeof import('../../t3-queue')>()),
  enqueueT3ForAnalyzedAsset: m.enqueueT3ForAnalyzedAsset,
  registerT3SweepStarter: (name: string, s: (ctx: unknown) => Promise<void>) => { m.starters.set(name, s); },
}));
vi.mock('../resolve-document-asset.service', () => ({ resolveDocumentAsset: m.resolve }));
vi.mock('../resolution.repository', () => ({ markPending: m.markPending }));
vi.mock('../../../queue/triggers', () => ({ isTriggerActive: async () => true }));
vi.mock('../../../queue/job-queue.repository', () => ({ enqueue: async () => ({ decision: 'create', jobId: 1 }) }));

const guard = { assertActive: vi.fn(async () => {}) };
const job = (o: Record<string, unknown>) => ({
  id: 1, attempts: 0, payload: {}, triggerCode: 'source_analyzed', accountId: 3, targetType: 'document', targetId: '9',
  origin: 'automatic', createdAt: new Date(), ...o,
}) as never;

describe('sortes de travail DOCUMENT_ASSET (registre t3-job-contract)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { registerReconciliationHandlers } = await import('../../index');
    registerReconciliationHandlers();
  });

  it('enregistrées : `document_asset` (cible document, compte requis) et sa page de rattrapage', async () => {
    const { listT3JobKinds, resolveT3Job } = await import('../../t3-job-contract');
    expect(listT3JobKinds()).toEqual(expect.arrayContaining(['document_asset', 'document_asset_sweep']));
    const { buildT3Payload } = await import('../../t3-job-contract');
    const r = resolveT3Job(job({ payload: buildT3Payload('document_asset', { userId: 2 }) }));
    expect(r).toMatchObject({ kind: 'document_asset', payloadVersion: 1, payload: { fileId: 9, userId: 2 } });
  });

  it('contexte malformé → PermanentJobError (jamais DONE)', async () => {
    const { resolveT3Job, buildT3Payload } = await import('../../t3-job-contract');
    const { PermanentJobError } = await import('../../../queue/queue-policy');
    expect(() => resolveT3Job(job({ payload: buildT3Payload('document_asset', { userId: 'x' }) }))).toThrow(PermanentJobError);
    expect(() => resolveT3Job(job({ targetId: 'abc', payload: buildT3Payload('document_asset', {}) }))).toThrow(PermanentJobError);
    expect(() => resolveT3Job(job({ accountId: null, payload: buildT3Payload('document_asset', {}) }))).toThrow(PermanentJobError);
    expect(() => resolveT3Job(job({ accountId: null, targetType: 'document_sweep', targetId: 'c:0', payload: buildT3Payload('document_asset_sweep', { page: 0 }) })))
      .toThrow(PermanentJobError);
  });

  it('exécution par `runT3Job` : garde, résultat métier du service, dernière tentative signalée', async () => {
    const { runT3Job, buildT3Payload } = await import('../../t3-queue');
    const out = await runT3Job(job({ attempts: 4, payload: buildT3Payload('document_asset', { userId: 2 }) }), guard as never, {} as never);
    expect(out).toMatchObject({ result: 'APPLIED', detail: { fileId: 9, assetIds: [4], method: 'DETERMINISTIC' } });
    expect(guard.assertActive).toHaveBeenCalled();
    expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ accountId: 3, fileId: 9, userId: 2, finalAttempt: true, guard }));
  });

  it('T3DOC-12 — rattrapage branché sur la racine du balayage planifié : page 0 unique par cycle', async () => {
    const starter = m.starters.get('document_asset')!;
    expect(starter).toBeDefined();
    const enqueue = vi.fn(async () => ({ decision: 'create', jobId: 5 }));
    const { startDocumentSweep } = await import('../queue');
    await startDocumentSweep({ cycleId: '77', triggerCode: 'schedule_hourly', guard: guard as never }, { enqueue, isTriggerActive: async () => true } as never);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T3', scope: { targetType: 'document_sweep', targetId: '77:0' }, triggerCode: 'schedule_hourly', onlyIfNeverQueued: true,
      payload: expect.objectContaining({ payloadVersion: 1, kind: 'document_asset_sweep', cycleId: '77', page: 0, afterFileId: 0 }),
    }));
  });
});

describe('abonné `source_analyzed`', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { registerReconciliationHandlers } = await import('../../index');
    registerReconciliationHandlers();
  });
  const result = { assetCandidates: [{ entityId: 5, confidence: 'probable', score: 0.6, reason: 'r', excerpt: 's', verified: true }] };

  it('T3DOC-01 — T1 avec bien certain → réconciliation du bien, aucun travail DOCUMENT_ASSET', async () => {
    await m.sub!({ accountId: 1, userId: 2, assetId: 5, leadSourceId: 9, result });
    expect(m.markPending).not.toHaveBeenCalled();
    expect(m.enqueueT3ForAnalyzedAsset).toHaveBeenCalledTimes(1);
  });

  it('T3DOC-02 — sans bien certain : contexte v1 `document_asset`, déclencheur `source_analyzed` vérifié', async () => {
    const { requestDocumentAssetResolution } = await import('../queue');
    const enqueue = vi.fn(async () => ({ decision: 'create', jobId: 8 }));
    const isTriggerActive = vi.fn(async () => true);
    await requestDocumentAssetResolution({ accountId: 1, userId: 2, fileId: 9, triggerCode: 'source_analyzed', t1Candidates: [] }, { enqueue, isTriggerActive } as never);
    expect(isTriggerActive).toHaveBeenCalledWith('T3', 'source_analyzed');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      scope: { accountId: 1, targetType: 'document', targetId: 9 }, triggerCode: 'source_analyzed',
      payload: expect.objectContaining({ payloadVersion: 1, kind: 'document_asset', userId: 2 }),
    }));
  });

  it('déclencheur `source_analyzed` inactif : aucun travail, déterministe seul puis « À traiter »', async () => {
    const { requestDocumentAssetResolution } = await import('../queue');
    const enqueue = vi.fn();
    const r = await requestDocumentAssetResolution({ accountId: 1, userId: 2, fileId: 9, triggerCode: 'source_analyzed' }, { enqueue, isTriggerActive: async () => false } as never);
    expect(r).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ fileId: 9, skipAi: true }));
  });

  it('l’abonné transmet les candidats T1 (identifiants vérifiés)', async () => {
    await m.sub!({ accountId: 1, userId: 2, assetId: null, leadSourceId: 9, result });
    expect(m.markPending).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 9, triggerCode: 'source_analyzed', t1Candidates: [{ assetId: 5, confidence: 'probable', score: 0.6, reason: 'r', signals: 's' }],
    }));
  });
});
