/**
 * Lot 3 — exécutant T1 en file durable : état du fichier et quota.
 *
 * Audit final BO IA, ligne 1 : « fichier laissé En file sur refus quota ».
 * L'état affiché à l'utilisateur suit désormais l'issue du job, et un refus de
 * quota REPORTE le job au lieu de le clore DONE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Update = { set: Record<string, unknown>; where: unknown };
const updates: Update[] = [];
vi.mock('@/db', () => ({
  db: {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async (where: unknown) => { updates.push({ set, where }); },
      }),
    }),
  },
  pgClient: { unsafe: async () => [] },
}));
// Conditions lisibles : on vérifie les états de départ autorisés.
vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  and: (...c: unknown[]) => ({ and: c }),
  eq: (_col: unknown, v: unknown) => ({ eq: v }),
  inArray: (_col: unknown, v: unknown) => ({ inArray: v }),
}));

let handler: ((job: unknown, guard: unknown) => Promise<void>) | null = null;
let hooks: { onSettled?: (job: never, o: never) => Promise<void> } | undefined;
const nudge = vi.fn();
vi.mock('../../../queue/queue-worker', () => ({
  registerJobHandler: (_t: string, h: typeof handler, k: typeof hooks) => { handler = h; hooks = k; },
  nudgeQueueWorker: () => nudge(),
}));
const enqueue = vi.fn(async (..._a: unknown[]) => ({ decision: 'create', jobId: 1 }));
vi.mock('../../../queue/job-queue.repository', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));
const analyze = vi.fn();
vi.mock('../../entrypoint', () => ({ analyzeFileSources: (...a: unknown[]) => analyze(...a) }));

const { registerSourceAnalysisHandler, onT1JobSettled, enqueueDurableFileAnalyses } = await import('../t1-handler');
const { isJobDeferred } = await import('../../../queue/queue-policy');
const { NO_GUARD } = await import('../../../queue/execution-control');

const job = (over: Record<string, unknown> = {}) => ({
  id: 1, treatment: 'T1', accountId: 5, targetType: 'asset_file', targetId: '42',
  payload: { fileId: 42, userId: 3, origin: 'files/confirm' }, ...over,
}) as never;

beforeEach(() => {
  updates.length = 0;
  analyze.mockReset();
  enqueue.mockClear();
  nudge.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  registerSourceAnalysisHandler();
});

describe('refus de quota', () => {
  it('le job est REPORTÉ (JobDeferredError), jamais clos DONE', async () => {
    analyze.mockResolvedValueOnce({ results: [], analysedCount: 0, skippedReason: 'quota' });
    const err = await handler!(job(), NO_GUARD).catch((e) => e);
    expect(isJobDeferred(err)).toBe(true);
    expect(String(err.message)).toMatch(/quota/);
  });

  it('analyse effectuée : aucun report', async () => {
    analyze.mockResolvedValueOnce({ results: [], analysedCount: 1 });
    await expect(handler!(job(), NO_GUARD)).resolves.toBeUndefined();
  });

  it('les suites sont enregistrées avec l’exécutant', () => {
    expect(hooks?.onSettled).toBe(onT1JobSettled);
  });
});

describe('état du fichier selon l’issue du job', () => {
  it('report (quota) : « non analysé » — jamais « En file » sans fin', async () => {
    await onT1JobSettled(job(), { kind: 'deferred', permanent: false, reason: 'quota' } as never);
    expect(updates[0].set.analysisState).toBeNull();
    expect(JSON.stringify(updates[0].where)).toContain('["UPLOADED","ANALYZING"]');
  });

  it('report définitif : idem, la reprise serveur prendra le relais au retour du crédit', async () => {
    await onT1JobSettled(job(), { kind: 'deferred', permanent: true, reason: 'quota' } as never);
    expect(updates[0].set.analysisState).toBeNull();
  });

  it('succès sans analyse (resté UPLOADED) : « non analysé »', async () => {
    await onT1JobSettled(job(), { kind: 'done' } as never);
    expect(updates[0].set.analysisState).toBeNull();
    expect(JSON.stringify(updates[0].where)).toContain('["UPLOADED"]');
  });

  it('échec avec nouvelle tentative : ANALYZING → « En file » (un job l’attend vraiment)', async () => {
    await onT1JobSettled(job(), { kind: 'failed', permanent: false, timedOut: false, error: 'x' } as never);
    expect(updates[0].set.analysisState).toBe('UPLOADED');
    expect(JSON.stringify(updates[0].where)).toContain('["ANALYZING"]');
  });

  it('échec définitif par délai global : ANALYSIS_FAILED motivé, compteur d’échecs incrémenté', async () => {
    await onT1JobSettled(job(), { kind: 'failed', permanent: true, timedOut: true, error: 'délai' } as never);
    expect(updates[0].set.analysisState).toBe('ANALYSIS_FAILED');
    expect(String(updates[0].set.analysisFailReason)).toMatch(/délai maximal/);
    expect(updates[0].set.analysisRetryCount).toBeDefined();
  });

  it('interruption (rollback, arrêt d’urgence) : ANALYZING → « En file » (remis en tête)', async () => {
    await onT1JobSettled(job(), { kind: 'interrupted', reason: 'rollback' } as never);
    expect(updates[0].set.analysisState).toBe('UPLOADED');
  });

  it('passage planifié (sans fichier) : rien n’est écrit', async () => {
    await onT1JobSettled(job({ accountId: null, targetType: null, targetId: null, payload: null }), { kind: 'done' } as never);
    expect(updates).toHaveLength(0);
  });
});

describe('mise en file durable', () => {
  it('réveille le boucleur dès qu’un fichier est accepté, et porte la non-facturation', async () => {
    const r = await enqueueDurableFileAnalyses([42, 42, 43], 5, { origin: 'analysis-recovery', billable: false });
    expect(r).toEqual([42, 43]);
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ payload: { fileId: 42, origin: 'analysis-recovery', billable: false } });
  });

  it('rien d’accepté : pas de réveil', async () => {
    enqueue.mockResolvedValueOnce({ decision: 'skip', jobId: 9 });
    await enqueueDurableFileAnalyses([42], 5, { origin: 'files/confirm' });
    expect(nudge).not.toHaveBeenCalled();
    expect((enqueue.mock.calls[0][0] as { payload: object }).payload).not.toHaveProperty('billable');
  });
});
