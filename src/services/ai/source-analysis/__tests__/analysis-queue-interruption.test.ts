/**
 * File mémoire T1 — revue indépendante lot IA 2.
 *
 * Un refus AI_BLOCKED (arrêt d'urgence, désactivation) pendant une analyse
 * n'est pas un échec : la source n'est pas marquée ANALYSIS_FAILED, elle
 * repasse « En file d'attente » et le travail reprend à la réactivation.
 * L'analyse s'exécute dans un contexte d'exécution (version figée, instant de
 * démarrage pour l'exemption MOD-011).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const updates: Array<Record<string, unknown>> = [];
vi.mock('@/db', () => ({
  db: {
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => { updates.push(patch); },
      }),
    }),
  },
  pgClient: { unsafe: async () => [] },
}));

let peutDemarrer = true;
vi.mock('../../queue/job-queue.repository', () => ({
  canStart: async () => peutDemarrer,
  enqueue: vi.fn(),
  LEASE_SECONDS: 300,
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => 42 }));

const analyze = vi.fn();
vi.mock('../entrypoint', () => ({ analyzeFileSources: (...a: unknown[]) => analyze(...a) }));

const { enqueueFileAnalyses, getAnalysisQueueState, __resetAnalysisQueueForTests } = await import('../analysis-queue');
const { AiGatewayError } = await import('../../gateway/errors');
const { currentJobContext } = await import('../../queue/job-context');

const attendre = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

beforeEach(() => {
  __resetAnalysisQueueForTests();
  updates.length = 0;
  analyze.mockReset();
  peutDemarrer = true;
  delete process.env.AI_DURABLE_QUEUE;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { __resetAnalysisQueueForTests(); vi.restoreAllMocks(); });

describe('file mémoire T1', () => {
  it('analyse dans un contexte d’exécution (version figée, instant de démarrage)', async () => {
    let ctx: unknown = null;
    analyze.mockImplementation(async () => { ctx = currentJobContext(); });
    await enqueueFileAnalyses([5], 1, { origin: 'test' });
    await attendre(() => ctx !== null);
    expect(ctx).toMatchObject({ treatment: 'T1', configVersionId: 42, jobId: null });
    expect((ctx as { startedAt: number }).startedAt).toEqual(expect.any(Number));
  });

  it('AI_BLOCKED : jamais ANALYSIS_FAILED ; source remise en file, travail repris en tête', async () => {
    analyze.mockImplementationOnce(async () => {
      // T1 est coupé pendant l'analyse : les démarrages suivants attendent.
      peutDemarrer = false;
      throw new AiGatewayError('AI_BLOCKED', 'extract_source', 'arrêt d’urgence', { recoverable: false });
    });
    await enqueueFileAnalyses([7], 1, { origin: 'test' });
    await attendre(() => analyze.mock.calls.length === 1
      && getAnalysisQueueState().pending === 1 && getAnalysisQueueState().running === 0);

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.analysisState === 'ANALYSIS_FAILED')).toBe(false);
    // Remise « En file d'attente », et pas « non analysé ».
    expect(updates.at(-1)).toMatchObject({ analysisState: 'UPLOADED' });
    expect(getAnalysisQueueState().pending).toBe(1);
    // Toujours « connu » : un nouveau dépôt du même fichier ne le double pas.
    await expect(enqueueFileAnalyses([7], 1, { origin: 'test' })).resolves.toEqual([]);
  });
});
