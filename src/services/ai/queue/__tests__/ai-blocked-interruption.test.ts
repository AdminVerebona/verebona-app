/**
 * AI_BLOCKED et exécutions déjà lancées — revue indépendante lot IA 2.
 *
 *   · MOD-011 / OPS-023 : sous disjoncteur, une exécution démarrée AVANT
 *     l'ouverture termine (exemption par l'instant de démarrage) ;
 *   · arrêt d'urgence, désactivation, suspension manuelle : aucune exemption ;
 *   · un refus AI_BLOCKED dans la file n'est pas un échec : le job est remis
 *     en tête sans consommer de tentative (MOD-005), jamais `failJob`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async () => ({ requeued: false }));
const failJob = vi.fn(async () => ({ permanent: false }));
const releaseInterruptedJob = vi.fn(async () => true);

vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: (...a: unknown[]) => completeJob(...(a as [])),
  failJob: (...a: unknown[]) => failJob(...(a as [])),
  releaseInterruptedJob: (...a: unknown[]) => releaseInterruptedJob(...(a as [])),
  renewLease: async () => true,
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async () => true,
  LEASE_SECONDS: 300,
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => null }));

const { runOne, registerJobHandler, clearJobHandlers } = await import('../queue-worker');
const {
  blockReason, assertTreatmentRunnable, setRuntimeSnapshotLoader, isAiBlocked,
} = await import('../runnable-guard');
type RuntimeSnapshot = import('../runnable-guard').RuntimeSnapshot;
const { runInJobContext } = await import('../job-context');
const { isExecutionCancelled } = await import('../execution-control');
const { AiGatewayError } = await import('../../gateway/errors');

const T0 = Date.parse('2026-09-26T10:00:00Z');
const suspenduParDisjoncteur: RuntimeSnapshot = {
  emergencyStop: false,
  states: { T1: 'SUSPENDED' },
  breakerSuspendedAt: { T1: T0 },
};

beforeEach(() => {
  clearJobHandlers();
  claimNext.mockReset();
  completeJob.mockClear();
  failJob.mockClear();
  releaseInterruptedJob.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { setRuntimeSnapshotLoader(null); vi.restoreAllMocks(); });

describe('exemption MOD-011 (blockReason)', () => {
  it('exécution démarrée AVANT l’ouverture du disjoncteur : laissée passer', () => {
    expect(blockReason(suspenduParDisjoncteur, 'T1', T0 - 1)).toBeNull();
  });
  it('exécution démarrée APRÈS, ou hors exécution : bloquée', () => {
    expect(blockReason(suspenduParDisjoncteur, 'T1', T0 + 1)).toMatch(/suspendu/);
    expect(blockReason(suspenduParDisjoncteur, 'T1', null)).toMatch(/suspendu/);
  });
  it('suspension MANUELLE (non disjoncteur) : aucune exemption', () => {
    expect(blockReason({ emergencyStop: false, states: { T1: 'SUSPENDED' } }, 'T1', T0 - 1)).toMatch(/suspendu/);
  });
  it('arrêt d’urgence et désactivation : jamais d’exemption', () => {
    expect(blockReason({ ...suspenduParDisjoncteur, emergencyStop: true }, 'T1', T0 - 1)).toMatch(/urgence/);
    expect(blockReason({ emergencyStop: false, states: { T1: 'DISABLED' } }, 'T1', T0 - 1)).toMatch(/désactivé/);
  });
});

describe('garde lue dans le contexte d’exécution', () => {
  it('le contexte du MÊME traitement, démarré avant, exempte ; un autre traitement non', async () => {
    setRuntimeSnapshotLoader(async () => suspenduParDisjoncteur);
    await expect(runInJobContext(
      { jobId: 1, treatment: 'T1', configVersionId: null, startedAt: T0 - 5 },
      () => assertTreatmentRunnable('T1', 'extract_source'),
    )).resolves.toBeUndefined();
    await expect(runInJobContext(
      { jobId: 2, treatment: 'T3', configVersionId: null, startedAt: T0 - 5 },
      () => assertTreatmentRunnable('T1', 'extract_source'),
    )).rejects.toMatchObject({ code: 'AI_BLOCKED' });
  });
});

describe('isExecutionCancelled et AI_BLOCKED', () => {
  const bloque = new AiGatewayError('AI_BLOCKED', 'x', 'bloqué', { recoverable: false });
  it('interruption dans une exécution de file ; hors file, repli inchangé', async () => {
    expect(isAiBlocked(bloque)).toBe(true);
    expect(isExecutionCancelled(bloque)).toBe(false);
    await runInJobContext({ jobId: 1, treatment: 'T3', configVersionId: null }, async () => {
      expect(isExecutionCancelled(bloque)).toBe(true);
    });
  });
});

describe('runOne : AI_BLOCKED = interruption, pas échec', () => {
  it('remet le job en tête sans tentative consommée, sans failJob ni clôture', async () => {
    claimNext.mockResolvedValueOnce({ id: 9, treatment: 'T3', executionId: 'exec-9', configVersionId: null });
    registerJobHandler('T3', async () => {
      throw new AiGatewayError('AI_BLOCKED', 'compare_values', 'arrêt d’urgence', { recoverable: false });
    });
    await expect(runOne('T3')).resolves.toBe(true);
    expect(releaseInterruptedJob).toHaveBeenCalledWith(9, 'exec-9', expect.stringMatching(/arrêt/));
    expect(failJob).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('une vraie erreur reste un échec (backoff)', async () => {
    claimNext.mockResolvedValueOnce({ id: 10, treatment: 'T3', executionId: 'exec-10', configVersionId: null });
    registerJobHandler('T3', async () => { throw new Error('panne'); });
    await runOne('T3');
    expect(failJob).toHaveBeenCalledWith(10, 'panne', 'exec-10');
    expect(releaseInterruptedJob).not.toHaveBeenCalled();
  });

  it('le contexte expose l’instant de démarrage (jeton MOD-011)', async () => {
    const { currentJobContext } = await import('../job-context');
    claimNext.mockResolvedValueOnce({ id: 11, treatment: 'T4', executionId: null, configVersionId: null });
    let vu: number | undefined;
    registerJobHandler('T4', async () => { vu = currentJobContext()?.startedAt; });
    const avant = Date.now();
    await runOne('T4');
    expect(vu).toBeGreaterThanOrEqual(avant);
  });
});
