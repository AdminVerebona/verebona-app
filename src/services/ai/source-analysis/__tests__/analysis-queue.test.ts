/**
 * File d'attente des analyses — un fichier par analyse, parallélisme borné.
 *
 * Le dépôt multiple passait tous les fichiers dans UNE analyse, dont le
 * regroupement IA pouvait fusionner des documents distincts. Ces tests
 * figent la règle : chaque fichier est analysé seul.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { analyzeFileSources, update } = vi.hoisted(() => {
  const chain = { set: () => chain, where: () => Promise.resolve() };
  return {
    analyzeFileSources: vi.fn(),
    update: vi.fn(() => chain),
  };
});

vi.mock('@/db', () => ({ db: { update } }));
vi.mock('@/db/schema', () => ({ assetFiles: { id: 'id', accountId: 'account_id', analysisState: 'analysis_state' } }));
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn(), inArray: vi.fn(), isNull: vi.fn(), or: vi.fn() }));
vi.mock('@/services/ai/source-analysis/entrypoint', () => ({ analyzeFileSources }));

import {
  enqueueFileAnalyses,
  getAnalysisQueueState,
  __resetAnalysisQueueForTests,
} from '@/services/ai/source-analysis/analysis-queue';

/** Attend qu'une condition soit vraie (l'import dynamique prend quelques tours). */
async function attendreQue(cond: () => boolean, max = 2000): Promise<void> {
  const debut = Date.now();
  while (!cond()) {
    if (Date.now() - debut > max) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('file d’attente des analyses', () => {
  beforeEach(() => {
    __resetAnalysisQueueForTests();
    analyzeFileSources.mockReset();
    update.mockClear();
  });

  it('analyse chaque fichier séparément', async () => {
    analyzeFileSources.mockResolvedValue(null);
    await enqueueFileAnalyses([11, 12, 13], 7, { userId: 3, origin: 'test' });
    await attendreQue(() => analyzeFileSources.mock.calls.length === 3);

    expect(analyzeFileSources).toHaveBeenCalledTimes(3);
    for (const appel of analyzeFileSources.mock.calls) {
      expect(appel[0]).toHaveLength(1);
      expect(appel[1]).toBe(7);
    }
    expect(analyzeFileSources.mock.calls.map((c) => c[0][0])).toEqual([11, 12, 13]);
  });

  it('borne le nombre d’analyses simultanées', async () => {
    const liberations: Array<() => void> = [];
    analyzeFileSources.mockImplementation(
      () => new Promise<null>((r) => liberations.push(() => r(null))),
    );
    await enqueueFileAnalyses([1, 2, 3, 4, 5], 7, { origin: 'test' });
    const { concurrency } = getAnalysisQueueState();
    await attendreQue(() => analyzeFileSources.mock.calls.length === concurrency);

    expect(getAnalysisQueueState().running).toBe(concurrency);
    expect(getAnalysisQueueState().pending).toBe(5 - concurrency);
    // Tant qu'aucune analyse ne se termine, aucune autre ne démarre.
    await new Promise((r) => setTimeout(r, 30));
    expect(analyzeFileSources).toHaveBeenCalledTimes(concurrency);

    // Chaque fin libère une place.
    while (analyzeFileSources.mock.calls.length < 5 || liberations.length > 0) {
      liberations.splice(0).forEach((f) => f());
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(analyzeFileSources).toHaveBeenCalledTimes(5);
  });

  it('ne met pas deux fois le même fichier en file', async () => {
    analyzeFileSources.mockImplementation(() => new Promise(() => {}));
    await enqueueFileAnalyses([21, 21], 7, { origin: 'test' });
    const ajoutes = await enqueueFileAnalyses([21], 7, { origin: 'test' });
    expect(ajoutes).toEqual([]);
  });

  it('marque les fichiers « en file d’attente »', async () => {
    analyzeFileSources.mockResolvedValue(null);
    await enqueueFileAnalyses([31], 7, { origin: 'test' });
    expect(update).toHaveBeenCalled();
  });
});
