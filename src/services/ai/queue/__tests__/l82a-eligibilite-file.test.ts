/**
 * Lot 82A (décision PO C-Q10, §3.3) — file IA durable : un travail dont le
 * compte n'est plus éligible (essai échu, suspendu, lecture seule) est
 * NEUTRALISÉ à l'exécution — ni exécutant, ni échec, ni report, ni suite
 * métier — y compris quand la passerelle refuse un appel EN COURS
 * d'exécution (`ACCOUNT_INELIGIBLE` = interruption dans une exécution de
 * file : les exécutants la laissent remonter sans repli déterministe).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async () => ({ requeued: false }));
const failJob = vi.fn(async () => ({ permanent: false }));
const deferJob = vi.fn(async () => ({ permanent: false }));
const deferJobUntil = vi.fn(async () => ({}));
const releaseInterruptedJob = vi.fn(async () => true);
const neutralizeIneligibleJob = vi.fn(async (..._a: unknown[]) => true);

vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: (...a: unknown[]) => completeJob(...(a as [])),
  failJob: (...a: unknown[]) => failJob(...(a as [])),
  deferJob: (...a: unknown[]) => deferJob(...(a as [])),
  deferJobUntil: (...a: unknown[]) => deferJobUntil(...(a as [])),
  releaseInterruptedJob: (...a: unknown[]) => releaseInterruptedJob(...(a as [])),
  neutralizeIneligibleJob: (...a: unknown[]) => neutralizeIneligibleJob(...a),
  recordJobAttempt: async () => undefined,
  renewLease: async () => true,
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async () => true,
  LEASE_SECONDS: 300,
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => null }));

const { runOne, registerJobHandler, clearJobHandlers } = await import('../queue-worker');
const { runInJobContext } = await import('../job-context');
const { isExecutionCancelled } = await import('../execution-control');
const { AiGatewayError } = await import('../../gateway/errors');
const E = await import('@/services/account/processing-eligibility');

const refusPasserelle = () => {
  const e = new AiGatewayError('ACCOUNT_INELIGIBLE', 't3_value_conflict', 'compte non éligible', { recoverable: false });
  Object.defineProperty(e, 'reason', { value: 'TRIAL_EXPIRED', enumerable: true });
  return e;
};

beforeEach(() => {
  clearJobHandlers();
  claimNext.mockReset();
  [completeJob, failJob, deferJob, deferJobUntil, releaseInterruptedJob, neutralizeIneligibleJob].forEach((f) => f.mockClear());
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  E.__setProcessingEligibilityForTests(async () => ({ eligible: true, reason: null }));
  vi.restoreAllMocks();
});

describe('L82A-Q01 — contrôle d’EXÉCUTION (travail mis en file avant la fin d’essai)', () => {
  it.each(['T1', 'T3', 'T4'] as const)('%s : compte devenu non éligible → exécutant jamais appelé, travail neutralisé, aucune suite', async (t) => {
    E.__setProcessingEligibilityForTests(async () => ({ eligible: false, reason: 'TRIAL_EXPIRED' }));
    const handler = vi.fn(async () => undefined);
    const settled = vi.fn(async () => undefined);
    claimNext.mockResolvedValueOnce({ id: 31, treatment: t, accountId: 5, targetType: null, targetId: null, payload: {}, executionId: 'exec-31', configVersionId: null });
    registerJobHandler(t, handler, { onSettled: settled });
    await expect(runOne(t)).resolves.toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(neutralizeIneligibleJob).toHaveBeenCalledWith(31, 'exec-31', 'TRIAL_EXPIRED');
    for (const f of [completeJob, failJob, deferJob, deferJobUntil, releaseInterruptedJob]) expect(f).not.toHaveBeenCalled();
    // Aucune suite métier (le fichier n'est pas marqué en échec).
    expect(settled).not.toHaveBeenCalled();
  });

  it('compte éligible : exécution normale (aucune régression)', async () => {
    const handler = vi.fn(async () => undefined);
    claimNext.mockResolvedValueOnce({ id: 32, treatment: 'T3', accountId: 5, targetType: null, targetId: null, payload: {}, executionId: 'exec-32', configVersionId: null });
    registerJobHandler('T3', handler);
    await runOne('T3');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(completeJob).toHaveBeenCalled();
    expect(neutralizeIneligibleJob).not.toHaveBeenCalled();
  });

  it('travail technique sans compte (balayage global) : non concerné', async () => {
    const lecture = vi.fn(async () => ({ eligible: false, reason: 'ACCOUNT_NOT_FOUND' as const }));
    E.__setProcessingEligibilityForTests(lecture);
    const handler = vi.fn(async () => undefined);
    claimNext.mockResolvedValueOnce({ id: 33, treatment: 'T3', accountId: null, targetType: null, targetId: null, payload: {}, executionId: 'exec-33', configVersionId: null });
    registerJobHandler('T3', handler);
    await runOne('T3');
    expect(handler).toHaveBeenCalled();
    expect(lecture).not.toHaveBeenCalled();
  });
});

describe('L82A-Q02 — refus de la passerelle PENDANT l’exécution (éligibilité perdue en cours)', () => {
  it('ACCOUNT_INELIGIBLE est une interruption dans une exécution de file, pas hors file', async () => {
    expect(isExecutionCancelled(refusPasserelle())).toBe(false);
    await runInJobContext({ jobId: 1, treatment: 'T3', configVersionId: null }, async () => {
      expect(isExecutionCancelled(refusPasserelle())).toBe(true);
    });
  });

  it('le travail est neutralisé (motif de la passerelle), jamais remis en tête ni compté en échec', async () => {
    claimNext.mockResolvedValueOnce({ id: 34, treatment: 'T3', accountId: 5, targetType: null, targetId: null, payload: {}, executionId: 'exec-34', configVersionId: null });
    registerJobHandler('T3', async () => { throw refusPasserelle(); });
    await runOne('T3');
    expect(neutralizeIneligibleJob).toHaveBeenCalledWith(34, 'exec-34', 'TRIAL_EXPIRED');
    expect(releaseInterruptedJob).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
  });

  it('T3 arbitrage de valeur : le refus remonte SANS repli déterministe (aucun conflit ouvert)', async () => {
    const { AiGateway } = await import('../../gateway/ai-gateway');
    vi.spyOn(AiGateway, 'execute').mockRejectedValue(refusPasserelle());
    const { resolveValueConflictMaster } = await import('../../reconciliation/master/value-conflict');
    const decision = { fieldKey: 'brand', action: 'auto_apply', reasonCode: 'X', deterministic: false } as never;
    await runInJobContext({ jobId: 3, treatment: 'T3', configVersionId: null }, async () => {
      await expect(resolveValueConflictMaster({ accountId: 5, decision, candidates: [], currentValue: null, currentOrigin: null } as never)).rejects.toMatchObject({ code: 'ACCOUNT_INELIGIBLE' });
    });
    // Hors file (route synchrone) : repli déterministe habituel.
    await expect(resolveValueConflictMaster({ accountId: 5, decision, candidates: [], currentValue: null, currentOrigin: null } as never)).resolves.toMatchObject({ action: 'create_conflict' });
  });
});
