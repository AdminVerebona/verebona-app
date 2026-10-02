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
/** État lu du fichier avant exécution (déduplication §5.7). */
let fichier: { state: string | null; updatedAt: Date } | null = null;
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (fichier ? [fichier] : []) }) }) }),
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
vi.mock('@/services/document-ai/analysis-recovery.service', () => ({ STUCK_THRESHOLD_MS: 10 * 60_000, runAnalysisRecovery: vi.fn() }));
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
  fichier = null;
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

describe('jamais deux analyses du même fichier (§5.7, §10.4 — ex-`dejaEnCours` de la file mémoire)', () => {
  it('fichier déjà ANALYZING (analyse directe en cours) : la file ne le relance pas, sortie propre', async () => {
    fichier = { state: 'ANALYZING', updatedAt: new Date(Date.now() - 60_000) };
    await expect(handler!(job(), NO_GUARD)).resolves.toBeUndefined();
    expect(analyze).not.toHaveBeenCalled();
    // Issue `done` : ses suites ne touchent qu'un fichier UPLOADED, jamais l'ANALYZING de l'autre analyse.
    await onT1JobSettled(job(), { kind: 'done' } as never);
    expect(JSON.stringify(updates[0].where)).toContain('["UPLOADED"]');
  });

  it('ANALYZING bloqué (plus de 10 min, même règle que la reprise serveur) : repris', async () => {
    fichier = { state: 'ANALYZING', updatedAt: new Date(Date.now() - 11 * 60_000) };
    analyze.mockResolvedValueOnce({ results: [], analysedCount: 1 });
    await handler!(job(), NO_GUARD);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('job repris après abandon (bail expiré) : l’ANALYZING est le sien, il le reprend', async () => {
    fichier = { state: 'ANALYZING', updatedAt: new Date() };
    analyze.mockResolvedValueOnce({ results: [], analysedCount: 1 });
    await handler!(job({ recoveredCount: 1 }), NO_GUARD);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('fichier « en file » (UPLOADED) : analysé normalement', async () => {
    fichier = { state: 'UPLOADED', updatedAt: new Date() };
    analyze.mockResolvedValueOnce({ results: [], analysedCount: 1 });
    await handler!(job(), NO_GUARD);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
});

describe('mise en file concurrente', () => {
  it('violation d’unicité (doublon vivant) : « déjà en file », pas une panne', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    enqueue.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "ai_job_queue_dedupe_uidx"'), { code: '23505' }));
    expect(await enqueueDurableFileAnalyses([42], 5, { origin: 'files/confirm' })).toEqual([]);
    expect(err).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
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
    // OBS-CFG : un dépôt porte le déclencheur du catalogue.
    expect(enqueue.mock.calls[0][0]).toMatchObject({ triggerCode: 'source_uploaded' });
  });
});
