/**
 * Lot 31C — contrat commun de la file durable (T1, T3, T4), sans base.
 *
 *  · T3Q-16/17/18 : exactement MAX_ATTEMPTS = 5 exécutions (plus de double
 *    comptage claimNext / afterFailure) ; backoff conservé ;
 *  · T3Q-08/11 : `PermanentJobError` → FAILED immédiat, jamais DONE ;
 *  · T3Q-12 : le résultat métier rendu par l'exécutant est écrit à la clôture ;
 *  · T3Q-35 : un timeout consomme une tentative (chemin d'échec normal) ;
 *  · T3Q-36 : exécutants sans résultat (T1, T4) : clôture inchangée.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async (..._a: unknown[]) => ({ requeued: false }));
const failJob = vi.fn(async (..._a: unknown[]) => ({ permanent: false }));
const releaseInterruptedJob = vi.fn(async (..._a: unknown[]) => true);

vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: (...a: unknown[]) => completeJob(...a),
  failJob: (...a: unknown[]) => failJob(...a),
  deferJob: async () => ({ permanent: false }),
  deferJobUntil: async () => ({}),
  renewLease: async () => true,
  releaseInterruptedJob: (...a: unknown[]) => releaseInterruptedJob(...a),
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async () => true,
  LEASE_SECONDS: 300,
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => null }));

const { runOne, registerJobHandler, clearJobHandlers } = await import('../queue-worker');
const {
  afterFailure, backoffSeconds, MAX_ATTEMPTS, PermanentJobError, isPermanentJobError, BUSINESS_RESULTS,
} = await import('../queue-policy');
const { EXECUTION_TIMEOUT_MS } = await import('../job-context');
const { currentJobContext } = await import('../job-context');
const { assertJobActive, abortLocalExecutions } = await import('../execution-control');

const job = (id: number, treatment = 'T3') => ({ id, treatment, executionId: `00000000-0000-0000-0000-0000000000${String(id).padStart(2, '0')}`, configVersionId: null });

beforeEach(() => {
  clearJobHandlers();
  for (const f of [claimNext, completeJob, failJob, releaseInterruptedJob]) f.mockClear();
  claimNext.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); });

describe('T3Q-16/17/18 — tentatives : exactement cinq exécutions', () => {
  it('MAX_ATTEMPTS = 5', () => expect(MAX_ATTEMPTS).toBe(5));

  it('T3Q-16 : exécutions 1 à 4 en échec → PENDING avec backoff exponentiel', () => {
    // `attempts` = compteur relu après le prélèvement (déjà incrémenté par claimNext).
    for (const n of [1, 2, 3, 4]) {
      const o = afterFailure(n, () => 0.5);
      expect(o.status, `exécution ${n}`).toBe('PENDING');
      expect(o.attempts).toBe(n); // jamais réincrémenté
      expect(o.retryInSeconds).toBe(backoffSeconds(n, () => 0.5));
    }
    expect([1, 2, 3, 4].map((n) => backoffSeconds(n, () => 0.5))).toEqual([30, 60, 120, 240]);
  });

  it('T3Q-17 : cinquième exécution en échec → FAILED', () => {
    expect(afterFailure(5)).toEqual({ status: 'FAILED', retryInSeconds: null, attempts: 5 });
  });

  it('T3Q-18 : simulation du cycle claimNext → échec → failJob : 5 exécutions réelles', () => {
    let attempts = 0;
    let executions = 0;
    let status: string = 'PENDING';
    while (status === 'PENDING') {
      attempts += 1; // claimNext : attempts = attempts + 1
      executions += 1;
      status = afterFailure(attempts).status; // failJob : décision sur le compteur relu
    }
    expect(executions).toBe(5);
    expect(status).toBe('FAILED');
  });

  it('backoff plafonné à 30 min, bruité ±20 %', () => {
    expect(backoffSeconds(20, () => 0.5)).toBe(30 * 60);
    expect(backoffSeconds(1, () => 0)).toBe(24);
    expect(backoffSeconds(1, () => 1)).toBe(36);
  });
});

describe('T3Q-08/11 — travail inexécutable : FAILED immédiat, jamais DONE', () => {
  it('PermanentJobError → failJob(..., { permanent: true }), jamais completeJob', async () => {
    claimNext.mockResolvedValueOnce(job(1));
    failJob.mockResolvedValueOnce({ permanent: true });
    const onSettled = vi.fn(async () => {});
    registerJobHandler('T3', async () => { throw new PermanentJobError('identifiant de cible « x » invalide'); }, { onSettled });
    await runOne('T3');
    expect(failJob).toHaveBeenCalledWith(1, expect.stringMatching(/inexécutable.*invalide/), job(1).executionId, { permanent: true });
    expect(completeJob).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'failed', permanent: true, timedOut: false }));
  });

  it('reconnue par son code (frontière de module)', () => {
    expect(isPermanentJobError(Object.assign(new Error('x'), { code: 'PERMANENT_JOB_ERROR' }))).toBe(true);
    expect(isPermanentJobError(new Error('x'))).toBe(false);
  });

  it('erreur ordinaire : échec récupérable (sans option permanent)', async () => {
    claimNext.mockResolvedValueOnce(job(2));
    registerJobHandler('T3', async () => { throw new Error('base indisponible'); });
    await runOne('T3');
    expect(failJob).toHaveBeenCalledWith(2, 'base indisponible', job(2).executionId);
  });
});

describe('T3Q-12 — résultat métier écrit à la clôture (DONE)', () => {
  it.each(BUSINESS_RESULTS)('%s → completeJob(..., résultat) et suites prévenues', async (code) => {
    claimNext.mockResolvedValueOnce(job(3));
    const onSettled = vi.fn(async () => {});
    registerJobHandler('T3', async () => ({ result: code, detail: { n: 1 } }), { onSettled });
    await runOne('T3');
    expect(completeJob).toHaveBeenCalledWith(3, job(3).executionId, { result: code, detail: { n: 1 } });
    expect(failJob).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(expect.anything(), { kind: 'done', result: { result: code, detail: { n: 1 } } });
  });

  it('T3Q-36 : exécutant sans résultat (T1, T4) — clôture inchangée', async () => {
    claimNext.mockResolvedValueOnce(job(4, 'T1'));
    registerJobHandler('T1', async () => {});
    await runOne('T1');
    expect(completeJob).toHaveBeenCalledWith(4, job(4, 'T1').executionId);
  });
});

describe('T3Q-34 — garde transmise par le contexte d’exécution', () => {
  it('assertJobActive : sans effet hors file, lève dans une exécution interrompue', async () => {
    await expect(assertJobActive('hors file')).resolves.toBeUndefined();
    claimNext.mockResolvedValueOnce(job(5));
    let memeGarde = false;
    let ecrit = false;
    registerJobHandler('T3', async (_j, guard) => {
      memeGarde = currentJobContext()?.guard === guard;
      // Interruption d'exploitation (désactivation) signalée à cette exécution.
      abortLocalExecutions([5], 'désactivation');
      await assertJobActive('écriture métier'); // lève : rien n'est écrit ensuite
      ecrit = true;
    });
    await runOne('T3');
    expect(memeGarde).toBe(true);
    expect(ecrit).toBe(false);
    expect(releaseInterruptedJob).toHaveBeenCalledWith(5, job(5).executionId, expect.stringMatching(/désactivation/));
    expect(failJob).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
  });
});

describe('T3Q-35 — timeout T3 (30 min) : échec qui consomme une tentative', () => {
  it('délai global dépassé → failJob (chemin d’échec normal, sans option permanent)', async () => {
    expect(EXECUTION_TIMEOUT_MS.T3).toBe(30 * 60_000);
    vi.useFakeTimers();
    claimNext.mockResolvedValueOnce(job(6));
    registerJobHandler('T3', (_j, guard) =>
      new Promise<void>((_, reject) => guard.signal.addEventListener('abort', () => reject(guard.signal.reason))));
    const p = runOne('T3');
    await vi.advanceTimersByTimeAsync(EXECUTION_TIMEOUT_MS.T3 + 10);
    await p;
    expect(failJob).toHaveBeenCalledWith(6, expect.stringMatching(/délai global/), job(6).executionId);
    expect(releaseInterruptedJob).not.toHaveBeenCalled();
  });
});
