/**
 * Lot 3 — bascule T1 en file durable, freins n°2 à 4.
 *
 *  · bail (OPS-001, NFR-003) : renouvelé tant que l'exécution travaille — une
 *    analyse plus longue que le bail n'est jamais reprise ailleurs ; perdu ou
 *    expiré sans renouvellement, l'exécution s'arrête ;
 *  · report (MOD-005, OPS-017) : un refus de quota n'est ni un succès ni un
 *    échec — retour en file avec délai croissant, sans tentative consommée,
 *    puis échec définitif motivé ;
 *  · délai global (GEN-012) : les suites du traitement sont prévenues d'un
 *    échec par dépassement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async (..._a: unknown[]) => ({ requeued: false }));
const failJob = vi.fn(async (..._a: unknown[]) => ({ permanent: false }));
const deferJob = vi.fn(async (..._a: unknown[]) => ({ permanent: false, retryInSeconds: 300, deferrals: 1 }));
const renewLease = vi.fn(async (..._a: unknown[]) => true as boolean);
const releaseInterruptedJob = vi.fn(async (..._a: unknown[]) => true);

vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: (...a: unknown[]) => completeJob(...a),
  failJob: (...a: unknown[]) => failJob(...a),
  deferJob: (...a: unknown[]) => deferJob(...a),
  renewLease: (...a: unknown[]) => renewLease(...a),
  releaseInterruptedJob: (...a: unknown[]) => releaseInterruptedJob(...a),
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async () => true,
  LEASE_SECONDS: 300,
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => null }));

const { runOne, registerJobHandler, clearJobHandlers } = await import('../queue-worker');
const { JobDeferredError, afterDeferral, deferralDelaySeconds, maxDeferrals, isJobDeferred } = await import('../queue-policy');
const { EXECUTION_TIMEOUT_MS } = await import('../job-context');

const job = (id: number, treatment = 'T3') => ({ id, treatment, executionId: `00000000-0000-0000-0000-00000000000${id}`, configVersionId: null });

const initial = { ...process.env };
beforeEach(() => {
  clearJobHandlers();
  for (const f of [claimNext, completeJob, failJob, deferJob, renewLease, releaseInterruptedJob]) f.mockClear();
  claimNext.mockReset();
  renewLease.mockImplementation(async () => true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); process.env = { ...initial }; });

describe('bail d’exécution (frein n°2)', () => {
  it('une exécution plus longue que le bail le renouvelle et se clôt normalement', async () => {
    vi.useFakeTimers();
    claimNext.mockResolvedValueOnce(job(1));
    // 12 minutes : quatre fois le bail de 300 s, sous le délai global T3 (30 min).
    registerJobHandler('T3', () => new Promise<void>((r) => setTimeout(r, 12 * 60_000)));
    const p = runOne('T3');
    await vi.advanceTimersByTimeAsync(12 * 60_000 + 10);
    await p;
    // Battement toutes les 100 s (bail / 3) : 7 renouvellements en 12 min.
    expect(renewLease.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(renewLease).toHaveBeenCalledWith(1, job(1).executionId);
    expect(completeJob).toHaveBeenCalledWith(1, job(1).executionId);
    expect(failJob).not.toHaveBeenCalled();
  });

  it('bail perdu (repris ailleurs) : l’exécution est interrompue, jamais close', async () => {
    vi.useFakeTimers();
    claimNext.mockResolvedValueOnce(job(2));
    renewLease.mockImplementation(async () => false);
    let signal: AbortSignal | undefined;
    registerJobHandler('T3', (_j, guard) => {
      signal = guard.signal;
      return new Promise<void>((_, reject) => guard.signal.addEventListener('abort', () => reject(guard.signal.reason)));
    });
    const p = runOne('T3');
    await vi.advanceTimersByTimeAsync(100_010);
    await p;
    expect(signal?.aborted).toBe(true);
    expect(completeJob).not.toHaveBeenCalled();
    expect(releaseInterruptedJob).toHaveBeenCalledWith(2, job(2).executionId, expect.stringMatching(/bail perdu/));
  });

  it('base injoignable jusqu’à l’échéance du bail : arrêt local, sans attendre la dépossession', async () => {
    vi.useFakeTimers();
    claimNext.mockResolvedValueOnce(job(3));
    renewLease.mockImplementation(async () => { throw new Error('ECONNRESET'); });
    registerJobHandler('T3', (_j, guard) =>
      new Promise<void>((_, reject) => guard.signal.addEventListener('abort', () => reject(guard.signal.reason))));
    const p = runOne('T3');
    // Avant l'échéance : les échecs réseau sont tolérés.
    await vi.advanceTimersByTimeAsync(250_000);
    expect(completeJob).not.toHaveBeenCalled();
    expect(releaseInterruptedJob).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(releaseInterruptedJob).toHaveBeenCalledWith(3, job(3).executionId, expect.stringMatching(/bail expiré/));
  });
});

describe('report (frein n°3)', () => {
  it('politique : délai croissant, puis échec définitif au-delà du plafond', () => {
    delete process.env.AI_QUEUE_MAX_DEFERRALS;
    expect(maxDeferrals()).toBe(3);
    expect(deferralDelaySeconds(1)).toBe(300);
    expect(deferralDelaySeconds(2)).toBe(900);
    expect(deferralDelaySeconds(3)).toBe(3_600);
    expect(deferralDelaySeconds(9)).toBe(3_600);
    expect(afterDeferral(0, 3)).toEqual({ status: 'PENDING', deferrals: 1, retryInSeconds: 300 });
    expect(afterDeferral(2, 3)).toEqual({ status: 'PENDING', deferrals: 3, retryInSeconds: 3_600 });
    expect(afterDeferral(3, 3).status).toBe('FAILED');
    process.env.AI_QUEUE_MAX_DEFERRALS = '0';
    expect(afterDeferral(0).status).toBe('FAILED');
    expect(isJobDeferred(new JobDeferredError('quota'))).toBe(true);
    expect(isJobDeferred(new Error('quota'))).toBe(false);
  });

  it('un report passe par deferJob — ni failJob, ni completeJob — et prévient les suites', async () => {
    claimNext.mockResolvedValueOnce(job(4, 'T1'));
    const onSettled = vi.fn(async () => {});
    registerJobHandler('T1', async () => { throw new JobDeferredError('quota d’analyse du compte épuisé'); }, { onSettled });
    await runOne('T1');
    expect(deferJob).toHaveBeenCalledWith(4, 'quota d’analyse du compte épuisé', job(4).executionId);
    expect(failJob).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), { kind: 'deferred', permanent: false, reason: 'quota d’analyse du compte épuisé' });
  });

  it('suites prévenues de chaque issue écrite ; une suite en échec ne casse rien', async () => {
    const onSettled = vi.fn(async (..._a: unknown[]) => { throw new Error('base indisponible'); });
    claimNext.mockResolvedValueOnce(job(5, 'T1')).mockResolvedValueOnce(job(6, 'T1'));
    let n = 0;
    registerJobHandler('T1', async () => { if (++n === 2) throw new Error('modèle indisponible'); }, { onSettled });
    await expect(runOne('T1')).resolves.toBe(true);
    await expect(runOne('T1')).resolves.toBe(true);
    expect(onSettled.mock.calls[0][1]).toEqual({ kind: 'done' });
    expect(onSettled.mock.calls[1][1]).toEqual({ kind: 'failed', permanent: false, timedOut: false, error: 'modèle indisponible' });
  });

  it('interruption : suites seulement si CETTE exécution a remis le job en file', async () => {
    const onSettled = vi.fn(async (..._a: unknown[]) => {});
    const { ExecutionCancelledError } = await import('../execution-control');
    registerJobHandler('T1', async () => { throw new ExecutionCancelledError('rollback'); }, { onSettled });

    // Déjà remis en file / repris par une autre instance : l'état du fichier
    // n'est plus le sien (un ANALYZING d'une reprise en cours ne doit pas
    // repasser « En file »).
    claimNext.mockResolvedValueOnce(job(10, 'T1'));
    releaseInterruptedJob.mockResolvedValueOnce(false);
    await runOne('T1');
    expect(onSettled).not.toHaveBeenCalled();

    claimNext.mockResolvedValueOnce(job(11, 'T1'));
    releaseInterruptedJob.mockResolvedValueOnce(true);
    await runOne('T1');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0][1]).toMatchObject({ kind: 'interrupted' });
  });

  it('exécution dépossédée : aucune suite (l’issue n’a pas été écrite)', async () => {
    completeJob.mockResolvedValueOnce({ requeued: false, stale: true } as never);
    const onSettled = vi.fn(async () => {});
    claimNext.mockResolvedValueOnce(job(7, 'T1'));
    registerJobHandler('T1', async () => {}, { onSettled });
    await runOne('T1');
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe('délai global (frein n°4, GEN-012)', () => {
  it('dépassement : failJob, puis suites prévenues d’un échec « timedOut »', async () => {
    vi.useFakeTimers();
    claimNext.mockResolvedValueOnce(job(8, 'T1'));
    failJob.mockResolvedValueOnce({ permanent: true });
    const onSettled = vi.fn(async () => {});
    // Exécutant qui respecte le signal : se termine aussitôt interrompu.
    registerJobHandler('T1', (_j, guard) =>
      new Promise<void>((_, reject) => guard.signal.addEventListener('abort', () => reject(guard.signal.reason))), { onSettled });
    const p = runOne('T1');
    await vi.advanceTimersByTimeAsync(EXECUTION_TIMEOUT_MS.T1 + 10);
    await p;
    expect(failJob).toHaveBeenCalledWith(8, expect.stringMatching(/délai global/), job(8).executionId);
    expect(onSettled).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'failed', permanent: true, timedOut: true }));
  });

  it('exécutant qui ignore la garde (moteur historique) : job tenu, bail renouvelé, jusqu’à sa fin réelle', async () => {
    vi.useFakeTimers();
    claimNext.mockResolvedValueOnce(job(9, 'T1'));
    const journal: string[] = [];
    registerJobHandler('T1', () => new Promise<void>((r) => {
      setTimeout(() => { journal.push('fin'); r(); }, EXECUTION_TIMEOUT_MS.T1 + 5 * 60_000);
    }));
    const p = runOne('T1');
    await vi.advanceTimersByTimeAsync(EXECUTION_TIMEOUT_MS.T1 + 60_000);
    // Délai dépassé, exécution toujours en cours : le job n'est PAS libéré
    // (une reprise ailleurs lancerait une seconde analyse), le bail court.
    expect(failJob).not.toHaveBeenCalled();
    const battements = renewLease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 10);
    await p;
    expect(journal).toEqual(['fin']);
    expect(renewLease.mock.calls.length).toBeGreaterThan(battements);
    expect(failJob).toHaveBeenCalledWith(9, expect.stringMatching(/délai global/), job(9).executionId);
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('le délai global T1 couvre plusieurs baux : c’est le renouvellement qui protège', () => {
    expect(EXECUTION_TIMEOUT_MS.T1).toBeGreaterThan(300_000);
  });
});
