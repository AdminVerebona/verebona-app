/**
 * Lot 3 — la reprise serveur et la file ne traitent jamais deux fois le même
 * fichier (§10.4). Lot 16b : la file durable est la seule file T1.
 *
 * La reprise appelait `analyzeFileSources` directement, à côté de la file :
 * un fichier dont le job T1 attendait son backoff, ou s'exécutait depuis plus
 * de dix minutes, était relancé une seconde fois. Elle écarte désormais ce que
 * la file tient déjà, et relance PAR la file (déduplication, concurrence
 * bornée). Elle reprend aussi les fichiers restés « En file » (E-06 : plus de
 * reprise déclenchée par le navigateur).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Résultats successifs des `db.select()` : comptes, puis candidats. */
let selects: unknown[][] = [];
const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
function chaine(result: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) c[m] = () => c;
  c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko);
  return c;
}
vi.mock('@/db', () => ({
  db: {
    select: () => chaine(selects.shift() ?? []),
    update: () => ({ set: (set: Record<string, unknown>) => ({ where: async (where: unknown) => { updates.push({ set, where }); } }) }),
  },
}));
vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  inArray: (_c: unknown, v: unknown) => ({ inArray: v }),
}));
vi.mock('@/lib/job-lock', () => ({ withJobLock: async (_n: string, _t: number, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/services/commercial-model.service', () => ({ canConsumeAnalysis: async () => ({ allowed: true }) }));

let vivants: Set<string> | Error = new Set();
vi.mock('@/services/ai/queue/job-queue.repository', () => ({
  listLiveTargets: async () => { if (vivants instanceof Error) throw vivants; return vivants; },
}));
const enqueueFileAnalyses = vi.fn(async (ids: number[]) => ids);
vi.mock('@/services/ai/source-analysis/queue/t1-handler', () => ({
  enqueueFileAnalyses: (ids: number[], ...r: unknown[]) => enqueueFileAnalyses(ids, ...(r as [])),
}));
// Aucun appel direct du pipeline, quel que soit le mode.
const analyzeDirect = vi.fn();
vi.mock('@/services/ai/source-analysis/entrypoint', () => ({ analyzeFileSources: (...a: unknown[]) => analyzeDirect(...a) }));

const { runAnalysisRecovery } = await import('../analysis-recovery.service');

const vieux = new Date(Date.now() - 60 * 60_000);
const candidats = [
  { id: 1, accountId: 5, analysisState: null, updatedAt: vieux },
  { id: 2, accountId: 5, analysisState: 'ANALYSIS_FAILED', updatedAt: vieux },
  { id: 3, accountId: 5, analysisState: 'ANALYZING', updatedAt: vieux },
  { id: 4, accountId: 6, analysisState: 'UPLOADED', updatedAt: vieux },
];

beforeEach(() => {
  selects = [[{ id: 5 }, { id: 6 }], candidats.map((c) => ({ ...c }))];
  updates.length = 0;
  vivants = new Set();
  enqueueFileAnalyses.mockClear();
  analyzeDirect.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
describe('file durable (seule file T1)', () => {
  it('écarte les fichiers ayant un job T1 vivant — y compris un ANALYZING long, jamais réinitialisé', async () => {
    vivants = new Set(['2', '3']);
    const r = await runAnalysisRecovery();
    expect(r).toEqual({ found: 2, retried: 2, errors: 0 });
    const relances = enqueueFileAnalyses.mock.calls.flatMap((c) => c[0] as number[]);
    expect(relances.sort()).toEqual([1, 4]);
    // L'ANALYZING du job en cours n'est pas remis à « non analysé ».
    expect(updates).toHaveLength(0);
    expect(analyzeDirect).not.toHaveBeenCalled();
  });

  it('relance par la file, compte par compte, non facturé', async () => {
    await runAnalysisRecovery();
    expect(enqueueFileAnalyses).toHaveBeenCalledWith([1, 2, 3], 5, { origin: 'analysis-recovery', billable: false });
    expect(enqueueFileAnalyses).toHaveBeenCalledWith([4], 6, { origin: 'analysis-recovery', billable: false });
    // ANALYZING bloqué SANS job vivant (processus mort) : réinitialisé.
    expect(updates).toHaveLength(1);
    expect(updates[0].set.analysisState).toBeNull();
    expect(JSON.stringify(updates[0].where)).toContain('[3]');
  });

  it('file durable illisible : rien n’est relancé (mieux vaut attendre que doubler)', async () => {
    vivants = new Error('connexion perdue');
    const r = await runAnalysisRecovery();
    expect(r.retried).toBe(0);
    expect(enqueueFileAnalyses).not.toHaveBeenCalled();
  });
});

describe('reprise serveur seule (E-06)', () => {
  it('reprend les fichiers restés « En file » sans job vivant (job abandonné, mise en file échouée)', async () => {
    const r = await runAnalysisRecovery();
    expect(r.retried).toBe(4);
    expect(enqueueFileAnalyses).toHaveBeenCalledWith([4], 6, expect.anything());
    expect(analyzeDirect).not.toHaveBeenCalled();
  });
});
