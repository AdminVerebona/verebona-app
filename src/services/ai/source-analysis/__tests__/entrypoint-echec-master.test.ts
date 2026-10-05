/**
 * Lot 16b-3 — point d'entrée T1 sans repli : échec du master.
 *
 *   · hors file (analyse directe, changement de bien, montée de référentiel…) :
 *     les sources en échec sont remises en FILE DURABLE, premier prélèvement
 *     différé (backoff), même règle de facturation que la demande initiale ;
 *   · sous la file (garde) : rien n'est remis en file ici (le job échoue et
 *     la file le reprend, `t1-handler`) ; une panne inattendue remonte ;
 *   · corpus (`retryOnFailure: false`, adaptateur dédié) : rien n'est relancé ;
 *   · plus de drapeau : `AI_UNIFIED_SOURCE_ANALYSIS=legacy` encore posée est
 *     sans effet, le moteur historique n'existe plus.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const run = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => [] as number[]));
vi.mock('../pipeline', () => ({ runSourceAnalysis: (...a: unknown[]) => run(...a) }));
vi.mock('../queue/t1-handler', () => ({ enqueueFileAnalyses: (...a: unknown[]) => enqueue(...a) }));
vi.mock('@/db', () => ({ db: {} }));

const { analyzeFileSources, registerAnalysisStreamWriter } = await import('../entrypoint');
const { ExecutionCancelledError } = await import('../../queue/execution-control');

const echec = { results: [], analysedCount: 0, failedSourceIds: [42] };
const garde = { assertActive: async () => {} } as never;

beforeEach(() => {
  run.mockReset();
  enqueue.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { delete process.env.AI_UNIFIED_SOURCE_ANALYSIS; });

describe('échec du master T1 — reprise par la file durable', () => {
  it('hors file : sources en échec remises en file, différées, facturation de la demande initiale', async () => {
    run.mockResolvedValue(echec);
    const r = await analyzeFileSources([42], 5, { userId: 3, origin: 'documents/analyze' });
    expect(r).toEqual(echec);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [ids, compte, opts] = enqueue.mock.calls[0] as [number[], number, Record<string, unknown>];
    expect(ids).toEqual([42]);
    expect(compte).toBe(5);
    expect(opts).toMatchObject({ userId: 3, origin: 'documents/analyze:reprise' });
    expect(opts).not.toHaveProperty('billable'); // facturable une fois, à la réussite
    expect(Number(opts.delaySeconds)).toBeGreaterThan(0);
  });

  it('hors file, demande non facturable : la reprise ne l’est pas non plus', async () => {
    run.mockResolvedValue(echec);
    await analyzeFileSources([42], 5, { userId: 3, origin: 'stripe-webhook/retroactive', billable: false });
    expect(enqueue.mock.calls[0][2]).toMatchObject({ billable: false });
  });

  it('sous la file : pas de remise en file ici (le job échoue, la file reprend)', async () => {
    run.mockResolvedValue(echec);
    await analyzeFileSources([42], 5, { userId: 3, origin: 'queue', guard: garde });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('corpus : rien n’est relancé (échec mesuré), ni pour une source d’un autre type', async () => {
    run.mockResolvedValue(echec);
    await analyzeFileSources([42], 5, { userId: 3, origin: 'corpus-pipeline', retryOnFailure: false });
    await analyzeFileSources([42], 5, { userId: 3, origin: 'x', sourceType: 'future_source' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('succès : rien n’est remis en file', async () => {
    run.mockResolvedValue({ results: [], analysedCount: 1, failedSourceIds: [] });
    await analyzeFileSources([42], 5, { userId: 3 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('panne inattendue : avalée hors file (null), remontée sous la file ; interruption toujours remontée', async () => {
    run.mockRejectedValue(new Error('base indisponible'));
    await expect(analyzeFileSources([42], 5, { userId: 3 })).resolves.toBeNull();
    await expect(analyzeFileSources([42], 5, { userId: 3, guard: garde })).rejects.toThrow('base indisponible');
    run.mockRejectedValue(new ExecutionCancelledError('rollback'));
    await expect(analyzeFileSources([42], 5, { userId: 3 })).rejects.toBeInstanceOf(ExecutionCancelledError);
  });

  it('AI_UNIFIED_SOURCE_ANALYSIS=legacy encore posée : sans effet, le pipeline tourne', async () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'legacy';
    run.mockResolvedValue({ results: [], analysedCount: 1, failedSourceIds: [] });
    await analyzeFileSources([42], 5, { userId: 3 });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'file', sourceIds: [42] }));
  });
});

describe('flux SSE', () => {
  it('un seul registre (celui du pipeline)', async () => {
    const recu: unknown[] = [];
    const off = await registerAnalysisStreamWriter(77, (d) => recu.push(d));
    const { broadcast } = await import('../stream/broadcast');
    broadcast(77, { type: 'progress', stage: 'extraction' });
    off();
    broadcast(77, { type: 'progress', stage: 'persistance' });
    expect(recu).toEqual([{ type: 'progress', stage: 'extraction' }]);
  });
});
