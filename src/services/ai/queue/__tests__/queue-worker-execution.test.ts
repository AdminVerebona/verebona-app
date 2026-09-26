/**
 * Boucleur — lot IA 2 : version figée au démarrage (VER-015, VER-016),
 * contexte d'exécution (job parent), timeout global (GEN-012).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async () => ({ requeued: false }));
const failJob = vi.fn(async () => ({ permanent: false }));

vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: (...a: unknown[]) => completeJob(...(a as [])),
  failJob: (...a: unknown[]) => failJob(...(a as [])),
  renewLease: async () => true,
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async () => true,
  LEASE_SECONDS: 300,
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => 12 }));

const { runOne, registerJobHandler, clearJobHandlers } = await import('../queue-worker');
const { currentJobContext, EXECUTION_TIMEOUT_MS } = await import('../job-context');

beforeEach(() => {
  clearJobHandlers();
  claimNext.mockReset();
  completeJob.mockClear();
  failJob.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('version figée au démarrage', () => {
  it('passe la version effective au prélèvement et l’expose à l’exécutant', async () => {
    claimNext.mockResolvedValueOnce({ id: 3, treatment: 'T3', executionId: null, configVersionId: 12 });
    let vu: unknown = null;
    registerJobHandler('T3', async () => { vu = currentJobContext(); });
    await runOne('T3');
    expect(claimNext).toHaveBeenCalledWith('T3', expect.any(String), 300, 12);
    expect(vu).toMatchObject({ jobId: 3, treatment: 'T3', configVersionId: 12 });
    expect(completeJob).toHaveBeenCalled();
  });

  it('hors exécution, aucun contexte', () => {
    expect(currentJobContext()).toBeNull();
  });
});

describe('timeout global d’exécution (GEN-012)', () => {
  it('distinct du timeout par appel, par traitement, attente en file exclue', () => {
    expect(EXECUTION_TIMEOUT_MS.T1).toBeGreaterThan(60_000);
    expect(EXECUTION_TIMEOUT_MS.T3).toBeGreaterThanOrEqual(EXECUTION_TIMEOUT_MS.T1);
  });

  it('au dépassement : exécution interrompue, job en échec (backoff), jamais clos', async () => {
    vi.useFakeTimers();
    claimNext.mockResolvedValueOnce({ id: 4, treatment: 'T4', executionId: null, configVersionId: null });
    let signal: AbortSignal | undefined;
    registerJobHandler('T4', (_job, guard) => { signal = guard.signal; return new Promise(() => {}); });
    const p = runOne('T4');
    await vi.advanceTimersByTimeAsync(EXECUTION_TIMEOUT_MS.T4 + 10);
    await expect(p).resolves.toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(failJob).toHaveBeenCalledWith(4, expect.stringMatching(/délai global/), null);
    expect(completeJob).not.toHaveBeenCalled();
  });
});
