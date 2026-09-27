/**
 * Lot 3 — bascule T1 en file durable, frein n°1 : débit du boucleur.
 *
 * CDC BO IA OPS-001, NFR-003, T1-024. Le boucleur servait les jobs un par un,
 * sous le bail du tour (30 s). Il tient désormais une concurrence bornée par
 * instance (`AI_QUEUE_CONCURRENCY`), prélève hors du bail d'entretien (sûr à
 * plusieurs instances : `claimNext` est atomique, SKIP LOCKED), et un
 * traitement ne peut pas occuper toutes les places.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const claimNext = vi.fn();
const completeJob = vi.fn(async () => ({ requeued: false }));
const recoverAbandonedJobs = vi.fn(async () => []);

vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: () => completeJob(),
  failJob: async () => ({ permanent: false }),
  deferJob: async () => ({ permanent: false }),
  renewLease: async () => true,
  recoverAbandonedJobs: () => recoverAbandonedJobs(),
  releaseInterruptedJob: async () => true,
  isExecutionActive: async () => true,
  LEASE_SECONDS: 300,
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => null }));

// Bail d'entretien : pris par une AUTRE instance (null) — le prélèvement doit
// quand même avoir lieu ici.
const withJobLock = vi.fn(async (_n: string, _ttl: number, _fn: () => Promise<unknown>) => null);
vi.mock('@/lib/job-lock', () => ({ withJobLock: (n: string, t: number, f: () => Promise<unknown>) => withJobLock(n, t, f) }));

const worker = await import('../queue-worker');
const { registerJobHandler, clearJobHandlers, fillSlots, getPoolState, queueConcurrency,
  perTreatmentCap, nudgeQueueWorker, __resetPoolForTests, startQueueWorker } = worker;

const attendre = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
};

/** File factice : `n` jobs par traitement, prélevés une seule fois chacun. */
function fileFactice(parTraitement: Partial<Record<string, number>>) {
  const restants = { ...parTraitement } as Record<string, number>;
  let id = 0;
  claimNext.mockImplementation(async (t: string) => {
    if (!restants[t]) return null;
    restants[t]--;
    return { id: ++id, treatment: t, executionId: null, configVersionId: null };
  });
}

/** Exécutant bloquant : mesure le pic de simultanéité, libéré à la demande. */
function executantBloquant() {
  let enCours = 0;
  let pic = 0;
  const liberations: Array<() => void> = [];
  const handler = async () => {
    enCours++; pic = Math.max(pic, enCours);
    await new Promise<void>((r) => liberations.push(r));
    enCours--;
  };
  return {
    handler,
    get pic() { return pic; },
    get enAttente() { return liberations.length; },
    toutLiberer: () => { while (liberations.length) liberations.shift()!(); },
  };
}

const initial = { ...process.env };
beforeEach(() => {
  __resetPoolForTests();
  clearJobHandlers();
  claimNext.mockReset();
  completeJob.mockClear();
  withJobLock.mockClear();
  recoverAbandonedJobs.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...initial }; vi.useRealTimers(); });

describe('réglage de la concurrence', () => {
  it('3 par défaut, configurable, borné à [1, 20]', () => {
    delete process.env.AI_QUEUE_CONCURRENCY;
    expect(queueConcurrency()).toBe(3);
    process.env.AI_QUEUE_CONCURRENCY = '8';
    expect(queueConcurrency()).toBe(8);
    for (const v of ['0', '-2', 'abc', '']) {
      process.env.AI_QUEUE_CONCURRENCY = v;
      expect(queueConcurrency(), v).toBe(3);
    }
    process.env.AI_QUEUE_CONCURRENCY = '500';
    expect(queueConcurrency()).toBe(20);
  });

  it('un traitement laisse toujours une place aux autres', () => {
    expect(perTreatmentCap(1)).toBe(1);
    expect(perTreatmentCap(3)).toBe(2);
    expect(perTreatmentCap(5)).toBe(4);
  });
});

describe('pool borné', () => {
  it('traite en parallèle sans jamais dépasser la borne (20 fichiers, 3 places)', async () => {
    process.env.AI_QUEUE_CONCURRENCY = '3';
    fileFactice({ T1: 20, T3: 5 });
    const ex = executantBloquant();
    registerJobHandler('T1', ex.handler);
    registerJobHandler('T3', ex.handler);

    fillSlots();
    await attendre(() => ex.enAttente === 3);
    expect(ex.enAttente).toBe(3);
    expect(getPoolState().active).toBe(3);

    // Les places se libèrent et se re-remplissent jusqu'à vider la file.
    for (let i = 0; i < 40 && completeJob.mock.calls.length < 25; i++) {
      ex.toutLiberer();
      await new Promise((r) => setTimeout(r, 5));
    }
    await attendre(() => completeJob.mock.calls.length === 25);
    expect(completeJob).toHaveBeenCalledTimes(25);
    expect(ex.pic).toBe(3);
    await attendre(() => getPoolState().active === 0);
    expect(getPoolState().active).toBe(0);
  });

  it('un traitement seul n’occupe pas toutes les places', async () => {
    process.env.AI_QUEUE_CONCURRENCY = '3';
    fileFactice({ T3: 10 });
    const ex = executantBloquant();
    registerJobHandler('T3', ex.handler);
    fillSlots();
    await attendre(() => ex.enAttente === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(ex.enAttente).toBe(2);
    expect(getPoolState().running.T3).toBe(2);
    ex.toutLiberer();
  });

  it('file vide : une seule place interroge la base, puis se referme', async () => {
    process.env.AI_QUEUE_CONCURRENCY = '5';
    claimNext.mockResolvedValue(null);
    for (const t of ['T1', 'T3', 'T4'] as const) registerJobHandler(t, async () => {});
    fillSlots();
    await attendre(() => getPoolState().active === 0);
    // Un passage par traitement, pas cinq.
    expect(claimNext).toHaveBeenCalledTimes(3);
  });

  it('le réveil (mise en file) est sans effet tant que le boucleur n’est pas démarré ici', async () => {
    claimNext.mockResolvedValue(null);
    registerJobHandler('T1', async () => {});
    nudgeQueueWorker();
    await new Promise((r) => setTimeout(r, 5));
    expect(claimNext).not.toHaveBeenCalled();
  });
});

describe('tour : entretien sous bail, prélèvement hors bail', () => {
  it('prélève même quand une autre instance tient le bail d’entretien, et le bail dure ≥ 60 s', async () => {
    vi.useFakeTimers();
    claimNext.mockResolvedValue(null);
    registerJobHandler('T1', async () => {});
    startQueueWorker();
    await vi.advanceTimersByTimeAsync(30_050);
    expect(withJobLock).toHaveBeenCalled();
    expect(withJobLock.mock.calls[0][1]).toBeGreaterThanOrEqual(60_000);
    // Le bail n'a pas été obtenu (autre instance) : prélèvement tout de même.
    expect(claimNext).toHaveBeenCalledWith('T1', expect.any(String), 300, null);

    // Démarré : le réveil déclenche un prélèvement immédiat.
    claimNext.mockClear();
    nudgeQueueWorker();
    await vi.advanceTimersByTimeAsync(1);
    expect(claimNext).toHaveBeenCalled();
  });

  it('les exécutions ne sont plus sous le bail du tour (source)', () => {
    const src = readFileSync(resolve(__dirname, '../queue-worker.ts'), 'utf8');
    const tick = src.slice(src.indexOf('const tick'));
    const bloc = tick.slice(tick.indexOf('withJobLock('), tick.indexOf('fillSlots();'));
    expect(bloc).not.toContain('runOnce(');
    expect(bloc).toContain('recoverAbandonedJobs()');
  });
});
