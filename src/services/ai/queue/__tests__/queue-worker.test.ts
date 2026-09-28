/**
 * CDC BO IA GEN-004, GEN-005, MOD-005 — boucleur de la file.
 *
 * Le boucleur ne connaît aucun traitement : il prélève, appelle l'exécutant
 * enregistré, écrit l'issue. Cette ignorance est ce qui empêche une
 * orchestration centrale, que le GEN-005 exclut de la V1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async (_id: unknown) => ({ requeued: false }));
const failJob = vi.fn(async (_id: unknown, _err: unknown) => ({ permanent: false }));

vi.mock('../job-queue.repository', () => ({
  claimNext: (t: unknown) => claimNext(t),
  completeJob: (id: unknown) => completeJob(id),
  failJob: (id: unknown, err: unknown) => failJob(id, err),
  renewLease: async () => true,
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async () => true,
  LEASE_SECONDS: 300,
}));

const { runOne, runOnce, registerJobHandler, clearJobHandlers, hasHandler } =
  await import('../queue-worker');

const job = (id: number) => ({ id, treatment: 'T1' });

beforeEach(() => {
  clearJobHandlers();
  claimNext.mockReset();
  completeJob.mockClear();
  failJob.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('registre des exécutants', () => {
  it("laisse les travaux en file quand aucun exécutant n'est enregistré", () => {
    // Mieux vaut un travail qui n'avance pas — le SCR-08 le montrera — qu'un
    // échec permanent qui le marquerait traité alors que personne n'a rien fait.
    expect(hasHandler('T1')).toBe(false);
  });

  it('ne prélève rien sans exécutant', async () => {
    expect(await runOne('T1')).toBe(false);
    expect(claimNext).not.toHaveBeenCalled();
  });
});

describe('exécution nominale', () => {
  it('clôt le travail quand l’exécutant rend', async () => {
    claimNext.mockResolvedValueOnce(job(1));
    const handler = vi.fn(async () => {});
    registerJobHandler('T1', handler);

    expect(await runOne('T1')).toBe(true);
    // Second argument : la garde d'exécution (annulation, contrôle avant écriture).
    expect(handler).toHaveBeenCalledWith(job(1), expect.objectContaining({ jobId: 1, assertActive: expect.any(Function) }));
    expect(completeJob).toHaveBeenCalledWith(1);
    expect(failJob).not.toHaveBeenCalled();
  });

  it('rend false quand la file est vide', async () => {
    claimNext.mockResolvedValueOnce(null);
    registerJobHandler('T1', async () => {});
    expect(await runOne('T1')).toBe(false);
  });
});

describe('échec d’un exécutant', () => {
  it('écrit l’échec sans lever', async () => {
    claimNext.mockResolvedValueOnce(job(2));
    registerJobHandler('T1', async () => { throw new Error('modèle indisponible'); });

    await expect(runOne('T1')).resolves.toBe(true);
    expect(failJob).toHaveBeenCalledWith(2, 'modèle indisponible');
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('n’interrompt pas la boucle', async () => {
    // Le travail suivant n'a pas à payer l'échec du précédent.
    claimNext.mockResolvedValueOnce(job(3)).mockResolvedValueOnce(job(4)).mockResolvedValue(null);
    let appels = 0;
    registerJobHandler('T1', async () => { appels++; if (appels === 1) throw new Error('x'); });

    await runOnce();
    expect(appels).toBe(2);
    expect(completeJob).toHaveBeenCalledWith(4);
  });
});

describe('équité entre traitements', () => {
  it('borne le travail par traitement dans un tour', async () => {
    // Sans borne, un traitement à la file longue monopoliserait le tour et les
    // deux autres n'avanceraient jamais.
    claimNext.mockImplementation(async (t: string) => (t === 'T1' ? job(9) : null));
    registerJobHandler('T1', async () => {});
    registerJobHandler('T3', async () => {});
    registerJobHandler('T4', async () => {});

    const n = await runOnce(3);
    expect(n).toBe(3);
  });

  it('sert les trois traitements batch', async () => {
    claimNext.mockResolvedValue(null);
    for (const t of ['T1', 'T3', 'T4'] as const) registerJobHandler(t, async () => {});
    await runOnce();
    expect(claimNext.mock.calls.map((c) => c[0])).toEqual(['T1', 'T3', 'T4']);
  });
});
