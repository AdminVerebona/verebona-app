/**
 * Lot 22 — refus `COST_CAP_REACHED` (plafond mensuel de coût IA du compte)
 * dans la file durable : ni échec, ni interruption remise en tête (ce serait
 * une boucle de relance), mais un REPORT unique au début de la période
 * suivante (`deferJobUntil`), sans tentative consommée — T1 SEULEMENT.
 * T3/T4 (décision PO, revue lot 22) : repli déterministe existant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claimNext = vi.fn();
const completeJob = vi.fn(async () => ({ requeued: false }));
const failJob = vi.fn(async () => ({ permanent: false }));
const deferJob = vi.fn(async () => ({ permanent: false }));
const deferJobUntil = vi.fn(async (..._a: unknown[]) => ({}));
const releaseInterruptedJob = vi.fn(async () => true);

vi.mock('../job-queue.repository', () => ({
  claimNext: (...a: unknown[]) => claimNext(...a),
  completeJob: (...a: unknown[]) => completeJob(...(a as [])),
  failJob: (...a: unknown[]) => failJob(...(a as [])),
  deferJob: (...a: unknown[]) => deferJob(...(a as [])),
  deferJobUntil: (...a: unknown[]) => deferJobUntil(...a),
  releaseInterruptedJob: (...a: unknown[]) => releaseInterruptedJob(...(a as [])),
  renewLease: async () => true,
  recoverAbandonedJobs: async () => [],
  isExecutionActive: async () => true,
  LEASE_SECONDS: 300,
}));
vi.mock('../../config/config-resolver', () => ({ resolveEffectiveVersionId: async () => null }));

const { runOne, registerJobHandler, clearJobHandlers } = await import('../queue-worker');
const { runInJobContext } = await import('../job-context');
const { isExecutionCancelled } = await import('../execution-control');
const { AiCostCapReachedError } = await import('../../gateway/errors');

const REPRISE = new Date('2026-10-31T23:00:00.000Z');
const refus = () => new AiCostCapReachedError('t3_value_conflict', 5, 1_000, 1_500, REPRISE);

beforeEach(() => {
  clearJobHandlers();
  claimNext.mockReset();
  [completeJob, failJob, deferJob, deferJobUntil, releaseInterruptedJob].forEach((f) => f.mockClear());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('isExecutionCancelled et COST_CAP_REACHED (décision PO, revue lot 22)', () => {
  it('jamais une interruption, même en file : T3/T4 appliquent leur repli déterministe', async () => {
    expect(isExecutionCancelled(refus())).toBe(false);
    await runInJobContext({ jobId: 1, treatment: 'T3', configVersionId: null }, async () => {
      expect(isExecutionCancelled(refus())).toBe(false);
    });
  });
});

describe('runOne : COST_CAP_REACHED', () => {
  it('T1 : deferJobUntil(date de reprise), ni échec, ni remise en tête, ni clôture', async () => {
    const settled = vi.fn(async () => undefined);
    claimNext.mockResolvedValueOnce({ id: 9, treatment: 'T1', accountId: 5, executionId: 'exec-9', configVersionId: null });
    registerJobHandler('T1', async () => { throw refus(); }, { onSettled: settled });
    await expect(runOne('T1')).resolves.toBe(true);
    expect(deferJobUntil).toHaveBeenCalledWith(9, expect.stringMatching(/^Plafond IA du mois atteint, reprise le 1er novembre/), REPRISE, 'exec-9');
    expect(failJob).not.toHaveBeenCalled();
    expect(deferJob).not.toHaveBeenCalled();
    expect(releaseInterruptedJob).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'deferred', permanent: false, until: REPRISE.toISOString() }));
  });

  it.each(['T3', 'T4'] as const)('%s : jamais reporté d’un mois (le report reste propre à T1)', async (t) => {
    claimNext.mockResolvedValueOnce({ id: 10, treatment: t, accountId: 5, executionId: 'exec-10', configVersionId: null });
    registerJobHandler(t, async () => { throw refus(); });
    await runOne(t);
    expect(deferJobUntil).not.toHaveBeenCalled();
    expect(releaseInterruptedJob).not.toHaveBeenCalled();
  });
});

describe('T3 / T4 en file au plafond : repli déterministe existant, aucun effet inventé', () => {
  it('T3 arbitrage de valeur : conflit ouvert (comme une abstention) ; T4 classification : repli « action » ambigu', async () => {
    vi.resetModules();
    vi.doMock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: async () => { throw refus(); } } }));
    const { resolveValueConflictMaster } = await import('../../reconciliation/master/value-conflict');
    const { classifyEventMaster } = await import('../../agenda/master/classify-event');
    const { runInJobContext: ctx } = await import('../job-context');
    const decision = { fieldKey: 'brand', action: 'auto_apply', reasonCode: 'X', deterministic: false } as never;
    await ctx({ jobId: 3, treatment: 'T3', configVersionId: null }, async () => {
      const d = await resolveValueConflictMaster({ accountId: 5, decision } as never);
      expect(d).toMatchObject({ action: 'create_conflict', reasonCode: 'AMBIGUOUS_EVIDENCE', deterministic: true });
    });
    await ctx({ jobId: 4, treatment: 'T4', configVersionId: null }, async () => {
      const c = await classifyEventMaster({ title: 'Vidange', date: '2026-11-02' } as never, { accountId: 5 } as never);
      expect(c).toMatchObject({ category: 'action', confidence: 'ambiguous', source: 'fallback' });
    });
    vi.doUnmock('../../gateway/ai-gateway');
  });
});
