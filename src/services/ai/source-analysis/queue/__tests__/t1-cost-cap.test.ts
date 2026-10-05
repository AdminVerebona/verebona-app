/**
 * Lot 22 — plafond mensuel de coût IA du compte atteint, exécutant T1.
 *
 *   · le pipeline n'a rien lancé (`skippedReason: 'cost_cap'`) : le job lève
 *     le refus daté de la passerelle, que le boucleur REPORTE au 1er ;
 *   · suites : fichier « en file » avec le motif « plafond IA du mois atteint,
 *     reprise le 1er … » (jamais « non analysé » ni « en échec ») ;
 *   · un report ordinaire (quota) garde son comportement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Update = { set: Record<string, unknown>; where: unknown };
const updates: Update[] = [];
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async (where: unknown) => { updates.push({ set, where }); },
      }),
    }),
  },
  pgClient: { unsafe: async () => [] },
}));
vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  and: (...c: unknown[]) => ({ and: c }),
  eq: (_col: unknown, v: unknown) => ({ eq: v }),
  inArray: (_col: unknown, v: unknown) => ({ inArray: v }),
}));
let handler: ((job: unknown, guard: unknown) => Promise<void>) | null = null;
vi.mock('../../../queue/queue-worker', () => ({
  registerJobHandler: (_t: string, h: typeof handler) => { handler = h; },
  nudgeQueueWorker: () => undefined,
}));
const enqueue = vi.fn(async (..._a: unknown[]) => ({ decision: 'create', jobId: 1 }));
vi.mock('../../../queue/job-queue.repository', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));
const analyze = vi.fn();
vi.mock('@/services/document-ai/analysis-recovery.service', () => ({ STUCK_THRESHOLD_MS: 10 * 60_000, runAnalysisRecovery: vi.fn() }));
vi.mock('../../entrypoint', () => ({ analyzeFileSources: (...a: unknown[]) => analyze(...a) }));

const { registerSourceAnalysisHandler, onT1JobSettled, enqueueDurableFileAnalyses } = await import('../t1-handler');
const { isCostCapReached, costCapResumeAt } = await import('../../../gateway/errors');
const { isJobDeferred } = await import('../../../queue/queue-policy');
const { NO_GUARD } = await import('../../../queue/execution-control');

const job = (over: Record<string, unknown> = {}) => ({
  id: 1, treatment: 'T1', accountId: 5, targetType: 'asset_file', targetId: '42',
  payload: { fileId: 42, userId: 3, origin: 'files/confirm' }, ...over,
}) as never;
const REPRISE = '2026-10-31T23:00:00.000Z';

beforeEach(() => {
  updates.length = 0;
  analyze.mockReset();
  enqueue.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  registerSourceAnalysisHandler();
});

describe('T1 : plafond IA du mois atteint', () => {
  it('le job lève le refus daté (report au 1er par le boucleur), pas un report ordinaire', async () => {
    analyze.mockResolvedValueOnce({
      results: [], analysedCount: 0, skippedReason: 'cost_cap', failedSourceIds: [],
      costCap: { resumeAt: REPRISE, capMicros: 1_000, spentMicros: 1_200 },
    });
    const err = await handler!(job(), NO_GUARD).catch((e) => e);
    expect(isCostCapReached(err)).toBe(true);
    expect(isJobDeferred(err)).toBe(false);
    expect(costCapResumeAt(err)?.toISOString()).toBe(REPRISE);
  });

  it('suites du report au 1er : fichier « en file » avec le motif daté', async () => {
    const motif = 'Plafond IA du mois atteint, reprise le 1er novembre : l’analyse sera lancée automatiquement.';
    await onT1JobSettled(job(), { kind: 'deferred', permanent: false, reason: motif, until: REPRISE });
    expect(updates[0].set).toMatchObject({ analysisState: 'UPLOADED', analysisFailReason: motif });
    expect(JSON.stringify(updates[0].where)).toContain('["UPLOADED","ANALYZING"]');
  });

  it('report ordinaire (quota) inchangé : fichier « non analysé »', async () => {
    await onT1JobSettled(job(), { kind: 'deferred', permanent: false, reason: 'quota' });
    expect(updates[0].set).toMatchObject({ analysisState: null });
    expect(updates[0].set).not.toHaveProperty('analysisFailReason');
  });

  it('mise en file différée hors file : date de report portée dans le contexte', async () => {
    await enqueueDurableFileAnalyses([42], 5, { origin: 'documents/analyze', delaySeconds: 3600, costCapDeferredUntil: REPRISE });
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      delaySeconds: 3600,
      payload: { fileId: 42, origin: 'documents/analyze', costCapDeferredUntil: REPRISE },
    });
  });
});
