/**
 * Lot 54A — règles pures de la phase A T3 : trace `[t3-enqueue]`, évaluation
 * de la planification (motifs, jamais « mis en file » sans création),
 * diagnostic de création affiché par la supervision.
 */
import { describe, expect, it } from 'vitest';
import { formatT3EnqueueTrace } from '../t3-enqueue-trace';
import { evaluateDueSchedules, runDueSchedules, type ScheduleDeps } from '../triggers';
import { diagnoseT3Creation, latestT3ScheduleEvaluation } from '../supervision';

const deps = (over: Partial<ScheduleDeps> = {}): ScheduleDeps => ({
  lastScheduledAt: async () => null,
  enqueueScheduled: async () => ({ decision: 'create', jobId: 9, reasonCode: null }),
  loadTriggers: async () => null,
  ...over,
});

describe('T3-JOB — trace [t3-enqueue]', () => {
  it('format manuel et planifié du ticket (§10)', () => {
    expect(formatT3EnqueueTrace({
      origin: 'manual', triggerCode: 'manual', accountId: 13, decision: 'create', jobId: 3027, persisted: true,
      steps: { requested: true, scopeEligible: true, scopeAllowed: true },
    })).toBe('[t3-enqueue] origin=manual trigger=manual accountId=13 requested=true scopeEligible=true scopeAllowed=true decision=create jobId=3027 persisted=true');
    expect(formatT3EnqueueTrace({ origin: 'automatic', triggerCode: 'schedule_hourly', decision: 'skip', reason: 'DUPLICATE_PENDING', jobId: 12, steps: { due: true } }))
      .toBe('[t3-enqueue] origin=automatic trigger=schedule_hourly due=true decision=skip reason=DUPLICATE_PENDING jobId=12');
  });
});

describe('T3-JOB — évaluation de la planification (TC07 à TC09)', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  it('TC07 : échue → create ; absorbée → motif, et runDueSchedules ne l’annonce plus', async () => {
    expect((await evaluateDueSchedules(now, deps())).find((o) => o.treatment === 'T3'))
      .toMatchObject({ due: true, decision: 'create', jobId: 9, triggerCode: 'schedule_hourly' });
    const absorbe = deps({ enqueueScheduled: async () => ({ decision: 'skip', jobId: 4, reasonCode: 'DUPLICATE_PENDING' }) });
    expect((await evaluateDueSchedules(now, absorbe)).find((o) => o.treatment === 'T3')).toMatchObject({ decision: 'skip', reasonCode: 'DUPLICATE_PENDING', jobId: 4 });
    expect(await runDueSchedules(now, absorbe)).toEqual([]);
  });
  it('TC08 : non échue → SCHEDULE_NOT_DUE, rien mis en file', async () => {
    let appels = 0;
    const o = (await evaluateDueSchedules(now, deps({
      lastScheduledAt: async () => new Date(now.getTime() - 10 * 60_000), enqueueScheduled: async () => { appels++; },
    }))).find((x) => x.treatment === 'T3');
    expect(o).toMatchObject({ due: false, reasonCode: 'SCHEDULE_NOT_DUE', nextDueAt: '2026-10-13T12:50:00.000Z' });
    expect(appels).toBe(0);
  });
  it('TC09 : planification coupée → TRIGGER_DISABLED', async () => {
    const o = (await evaluateDueSchedules(now, deps({ loadTriggers: async () => [{ code: 'schedule_hourly', active: false }] as never })))
      .find((x) => x.treatment === 'T3');
    expect(o).toMatchObject({ due: false, triggerCode: null, reasonCode: 'TRIGGER_DISABLED' });
  });
  it('erreur de mise en file → INSERT_FAILED, ne lève pas', async () => {
    const o = (await evaluateDueSchedules(now, deps({ enqueueScheduled: async () => { throw new Error('violates check constraint'); } })))
      .find((x) => x.treatment === 'T3');
    expect(o).toMatchObject({ decision: 'error', reasonCode: 'INSERT_FAILED', error: 'violates check constraint' });
  });
});

describe('T3-JOB — diagnostic de création (supervision, sans SQL)', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const base = {
    now, emergencyStop: false, migrations: { heartbeats0338: true, enqueueTrace0370: true },
    workers: { state: 'OK' as const, liveInstances: 1 }, scheduleTriggerCode: 'schedule_hourly',
    scheduleNextDueAt: '2026-10-13T12:30:00Z',
    scheduleEvaluation: { at: '2026-10-13T11:59:50Z', workerId: 'w', due: false, decision: 'none', reasonCode: 'SCHEDULE_NOT_DUE', jobId: null, nextDueAt: null, error: null },
    lastManualRequest: null, liveCommits: ['abcdef1'], servingCommit: 'abcdef1',
  };
  it('nominal → OK', () => {
    expect(diagnoseT3Creation(base).map((f) => f.code)).toEqual(['OK']);
  });
  it('boucleur vivant sans évaluation récente → SCHEDULER_STALLED (code antérieur ou entretien bloqué)', () => {
    expect(diagnoseT3Creation({ ...base, scheduleEvaluation: null }).map((f) => f.code)).toContain('SCHEDULER_STALLED');
  });
  it('échue mais absorbée, dernière demande manuelle refusée, arrêt d’urgence, migrations, versions mêlées', () => {
    const codes = diagnoseT3Creation({
      ...base, emergencyStop: true, migrations: { heartbeats0338: false, enqueueTrace0370: false },
      scheduleEvaluation: { ...base.scheduleEvaluation, due: true, decision: 'skip', reasonCode: 'DUPLICATE_PENDING', jobId: 5 },
      lastManualRequest: { decision: 'refused', reasonCode: 'NO_ELIGIBLE_ACCOUNT', reasonLabel: null, accountId: 3, createdAt: '' },
      liveCommits: ['a1b2c3d', 'e4f5a6b'], servingCommit: null,
    }).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['EMERGENCY_STOP', 'MIGRATION_0338_MISSING', 'MIGRATION_0370_MISSING', 'UNKNOWN_COMMIT', 'MIXED_VERSIONS', 'LAST_MANUAL_REFUSED']));
    expect(codes).not.toContain('OK');
  });
  it('dernière évaluation T3 parmi les instances', () => {
    const e = latestT3ScheduleEvaluation([
      { workerId: 'a', schedule: { at: '2026-10-13T11:00:00Z', outcomes: [{ treatment: 'T3', due: true, decision: 'create', jobId: 1 }] } },
      { workerId: 'b', schedule: { at: '2026-10-13T11:59:00Z', outcomes: [{ treatment: 'T3', due: false, decision: 'none', reasonCode: 'SCHEDULE_NOT_DUE' }] } },
      { workerId: 'c', schedule: null },
    ]);
    expect(e).toMatchObject({ workerId: 'b', reasonCode: 'SCHEDULE_NOT_DUE' });
  });
});
