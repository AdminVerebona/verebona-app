/**
 * Lot 52A — ticket « [P1] T3 — Identifier et corriger le non-déclenchement
 * des exécutions manuelles et horaires » : règles PURES (sans base). Les
 * scénarios NR-01 à NR-10 sur PostgreSQL réel sont dans
 * `src/test/e2e/scenarios/l52a-t3-declenchement.e2e.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { launchManual, ManualLaunchRefused, type ManualLaunchDeps } from '../manual-launch';
import { executionPhase, t3ExecutorAvailability, summarizeT3Job } from '../supervision';
import { summarizeWorkers, isWorkerAlive, type WorkerHeartbeatRow } from '../worker-heartbeat';
import { cleanJobIds, type QueuedJob } from '../job-queue.repository';
import { sweepFreshSince } from '../../reconciliation/t3-queue';
import { orphanRunCleanupSql } from '../../reconciliation/account-reconciliation.service';

function deps(over: Partial<ManualLaunchDeps> = {}) {
  let n = 100;
  const enqueue = vi.fn(async () => ({ jobId: ++n, decision: 'create' as const }));
  const nudge = vi.fn();
  const d: ManualLaunchDeps = {
    emergencyStopActive: async () => false,
    canStart: async () => true,
    listFiles: async (ids) => (ids ?? [1]).map((a) => ({ id: a * 10, accountId: a })),
    listAccounts: async (ids) => (ids ?? [1, 2]).filter((a) => a !== 99),
    listT4Sources: async () => [],
    enqueue: enqueue as unknown as ManualLaunchDeps['enqueue'],
    nudge,
    ...over,
  };
  return { d, enqueue, nudge };
}

const job = (over: Partial<QueuedJob> = {}): QueuedJob => ({
  id: 7, treatment: 'T3', accountId: 4, targetType: null, targetId: null, status: 'PENDING', origin: 'manual',
  triggerCode: 'manual', attempts: 0, lastError: null, availableAt: new Date(), coalesceRequested: false, headPriority: false,
  createdAt: new Date('2026-10-13T08:00:00Z'), startedAt: null, finishedAt: null, payload: { kind: 'account' }, executionId: null,
  workerId: null, leaseExpiresAt: null, recoveredCount: 0, configVersionId: null, businessResult: null, businessResultDetail: null,
  ...over,
});

const hb = (over: Partial<WorkerHeartbeatRow> = {}): WorkerHeartbeatRow => ({
  workerId: 'web-1:12:ab', hostname: 'web-1', pid: 12, startedAt: new Date('2026-10-13T07:00:00Z'),
  lastTickAt: new Date('2026-10-13T08:00:00Z'), lastClaimAt: null, lastClaimTreatment: null, lastError: null, lastErrorAt: null,
  handlers: ['T1', 'T3', 'T4'], concurrency: 3, activeSlots: 0, running: {}, intervalMs: 15_000, ...over,
});

describe('NR-01 / COR-02 — lancement manuel : jobs persistés, réveil, motif explicite', () => {
  it('NR-01 : rend les identifiants persistés, avec leur compte, et réveille le boucleur', async () => {
    const { d, nudge } = deps({ confirmPersisted: async (ids) => ids });
    const r = await launchManual('T3', { accountIds: [1, 2] }, 9, {}, d);
    expect(r.jobIds).toEqual([101, 102]);
    expect(r.jobs).toEqual([{ id: 101, accountId: 1 }, { id: 102, accountId: 2 }]);
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('COR-02 : seuls les jobs relus en base sont annoncés', async () => {
    const { d } = deps({ confirmPersisted: async () => [102] });
    const r = await launchManual('T3', { accountIds: [1, 2] }, 9, {}, d);
    expect(r.jobIds).toEqual([102]);
    expect(r.objects).toBe(1);
  });

  it('NR-07 / COR-02 : aucun job créé (refus de périmètre) → refus explicite, jamais de succès, aucun réveil', async () => {
    const { d, nudge } = deps({ enqueue: (async () => ({ jobId: null, decision: 'skip' })) as unknown as ManualLaunchDeps['enqueue'] });
    const e = await launchManual('T3', { accountIds: [1] }, 9, {}, d).catch((x) => x);
    expect(e).toBeInstanceOf(ManualLaunchRefused);
    expect(e.code).toBe('NO_JOB_CREATED');
    expect(e.message).toMatch(/contrôle de périmètre/);
    expect(e.details).toMatchObject({ refused: 1 });
    expect(nudge).not.toHaveBeenCalled();
  });

  it('NR-09 : un compte demandé mais hors périmètre est nommé (estimation et lancement)', async () => {
    const { d } = deps();
    const est = await launchManual('T3', { accountIds: [1, 99] }, 9, { dryRun: true }, d);
    expect(est.excludedAccountIds).toEqual([99]);
    const e = await launchManual('T3', { accountIds: [99] }, 9, {}, d).catch((x) => x);
    expect(e.code).toBe('EMPTY_SCOPE');
    expect(e.message).toMatch(/ni bien actif ni élément « À traiter » ouvert/);
  });

  it('NR-05 : T3 coupé → la demande est acceptée et attend la réactivation', async () => {
    const { d } = deps({ canStart: async () => false });
    await expect(launchManual('T3', { accountIds: [1] }, 9, {}, d)).resolves.toMatchObject({ waitsForReactivation: true, jobIds: [101] });
  });

  it('NR-08 : T1 manuel — contexte inchangé (technique, non facturé)', async () => {
    const { d, enqueue } = deps();
    await launchManual('T1', { accountIds: [3] }, 9, {}, d);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T1', origin: 'manual', triggerCode: 'manual',
      payload: expect.objectContaining({ billable: false, processingVisibility: 'TECHNICAL', origin: 'admin/manual' }),
    }));
  });
});

describe('COR-05 — phase lisible d’un job', () => {
  it('créé non démarré, en attente de reprise, démarré, terminé avec / sans modification, échec', () => {
    expect(executionPhase(job())).toBe('CREATED_NOT_STARTED');
    expect(executionPhase(job({ attempts: 1, lastError: 'x' }))).toBe('WAITING_RETRY');
    expect(executionPhase(job({ status: 'RUNNING', attempts: 1 }))).toBe('STARTED');
    expect(executionPhase(job({ status: 'DONE', businessResult: 'NO_CHANGE' }))).toBe('DONE_NO_CHANGE');
    expect(executionPhase(job({ status: 'DONE', businessResult: 'APPLIED' }))).toBe('DONE_CHANGED');
    expect(executionPhase(job({ status: 'DONE', businessResult: 'FAILED' }))).toBe('FAILED');
    expect(executionPhase(job({ status: 'DONE' }))).toBe('DONE');
    expect(executionPhase(job({ status: 'FAILED' }))).toBe('FAILED');
    expect(executionPhase(job({ status: 'CANCELLED' }))).toBe('CANCELLED');
  });

  it('NR-03 : résumé d’un passage NO_CHANGE sans appel modèle (durée, objets, appels)', () => {
    const s = summarizeT3Job(job({
      status: 'DONE', attempts: 1, businessResult: 'NO_CHANGE',
      startedAt: new Date('2026-10-13T08:00:01Z'), finishedAt: new Date('2026-10-13T08:00:04Z'),
      businessResultDetail: { objectsExamined: 2, objectsModified: 0, aiCalls: 0, openActionsExamined: 3 },
    }));
    expect(s).toMatchObject({ phase: 'DONE_NO_CHANGE', durationMs: 3000, objectsExamined: 2, objectsModified: 0, aiCalls: 0, openActionsExamined: 3, reason: null });
  });
});

describe('COR-04 — boucleur multi-instances et disponibilité de l’exécutant T3', () => {
  const now = new Date('2026-10-13T08:01:00Z');
  it('une instance est vivante si son dernier tour a moins de 90 s (3 intervalles au moins)', () => {
    expect(isWorkerAlive(hb(), now)).toBe(true);
    expect(isWorkerAlive(hb({ lastTickAt: new Date('2026-10-13T07:58:00Z') }), now)).toBe(false);
  });

  it('NR-06 : l’état est celui du SERVICE (toutes instances), jamais d’un seul processus', () => {
    const s = summarizeWorkers([
      hb({ workerId: 'a', lastTickAt: new Date('2026-10-13T07:30:00Z') }),
      hb({ workerId: 'b', handlers: ['T1', 'T4'] }),
      hb({ workerId: 'c', lastClaimAt: new Date('2026-10-13T08:00:30Z') }),
    ], now);
    expect(s).toMatchObject({ state: 'OK', liveInstances: 2, knownInstances: 3, t3ExecutorInstances: 1 });
    expect(s.lastClaimAt?.toISOString()).toBe('2026-10-13T08:00:30.000Z');
  });

  it('NR-04 : aucune instance vivante → indisponible, motif explicite (jobs conservés)', () => {
    const workers = summarizeWorkers([hb({ lastTickAt: new Date('2026-10-13T07:00:00Z') })], now);
    expect(workers.state).toBe('NO_LIVE_WORKER');
    const a = t3ExecutorAvailability({ emergencyStop: false, state: 'ENABLED', workers });
    expect(a).toMatchObject({ available: false, code: 'NO_LIVE_WORKER' });
    expect(a.reason).toMatch(/restent en file/);
  });

  it('exécutant T3 absent de toutes les instances vivantes → indisponible', () => {
    const workers = summarizeWorkers([hb({ handlers: ['T1'] })], now);
    expect(t3ExecutorAvailability({ emergencyStop: false, state: 'ENABLED', workers }).code).toBe('NO_T3_EXECUTOR');
  });

  it('NR-05 : arrêt d’urgence, désactivation, suspension priment, avec leur motif', () => {
    const workers = summarizeWorkers([hb()], now);
    expect(t3ExecutorAvailability({ emergencyStop: true, state: 'ENABLED', workers }).code).toBe('EMERGENCY_STOP');
    expect(t3ExecutorAvailability({ emergencyStop: false, state: 'DISABLED', workers }).code).toBe('DISABLED');
    const s = t3ExecutorAvailability({ emergencyStop: false, state: 'SUSPENDED', suspendedReason: 'disjoncteur', workers });
    expect(s).toMatchObject({ code: 'SUSPENDED', available: false });
    expect(s.reason).toMatch(/disjoncteur/);
    expect(t3ExecutorAvailability({ emergencyStop: false, state: 'ENABLED', workers }).available).toBe(true);
  });

  it('table des battements absente → état inconnu, jamais « tout va bien » inventé', () => {
    expect(summarizeWorkers(null, now).state).toBe('UNKNOWN');
  });
});

describe('COR-03 — recherche par identifiant', () => {
  it('identifiants nettoyés, dédoublonnés, bornés', () => {
    expect(cleanJobIds(['12', ' 57 ', 'abc', 12, -3, 0, 1.5])).toEqual([12, 57]);
    expect(cleanJobIds(Array.from({ length: 900 }, (_, i) => i + 1))).toHaveLength(500);
  });
});

describe('NR-02 — cadence horaire du balayage', () => {
  it('un compte rationalisé par le cycle PRÉCÉDENT n’est plus « frais » au cycle suivant', () => {
    const debutCycle = new Date('2026-10-13T09:00:05Z');
    const since = sweepFreshSince(debutCycle, 1);
    // Passage du cycle précédent : terminé 40 s après le début de ce cycle-là.
    const passagePrecedent = new Date('2026-10-13T08:00:45Z');
    expect(passagePrecedent > since).toBe(false);
    // Un passage événementiel d'il y a 10 min dispense toujours du balayage.
    expect(new Date('2026-10-13T08:50:00Z') > since).toBe(true);
  });
});

describe('NR-10 — exécution T3 orpheline après redéploiement', () => {
  it('la règle de nettoyage reconnaît un run dont le job n’est plus RUNNING avec le même jeton', () => {
    const sql = orphanRunCleanupSql(true);
    expect(sql).toMatch(/queue_job_id IS NOT NULL AND NOT EXISTS/);
    expect(sql).toMatch(/q\.execution_id IS NOT DISTINCT FROM r\.queue_execution_id/);
    expect(orphanRunCleanupSql(false)).not.toMatch(/queue_job_id/);
  });
});
