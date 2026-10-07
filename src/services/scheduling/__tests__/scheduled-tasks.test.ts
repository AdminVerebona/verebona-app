/**
 * Tâches planifiées internes (lot 25, chantier A) — calendrier Europe/Paris,
 * exclusivité, isolement des erreurs, délais, alertes, arrêt d'urgence.
 *
 * Le moteur est exercé contre un état EN MÉMOIRE qui reproduit la sémantique
 * de la table `scheduled_task_state` (prise conditionnelle atomique, fin
 * clôturée par l'identifiant d'exécution). La version PostgreSQL est couverte
 * par `l25-taches-planifiees.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Verrous internes (`job-lock`) : base simulée, pour distinguer « détenu » d'« erreur ».
const dbExecute = vi.fn();
vi.mock('@/db', () => ({ db: { execute: (...a: unknown[]) => dbExecute(...a) } }));
import {
  computeFirstRun, computeNextRun, describeSchedule, inParisWindow, isSlotStillValid,
  nextDailyAt, nextWeeklyAt, parisWallTimeToDate, type TaskSchedule,
} from '../task-calendar';
import {
  SCHEDULED_TASKS, isTaskEnabled, schedulerDisabled, taskEnvVar, type ScheduledTaskDef, type TaskEnv,
} from '../scheduled-tasks.catalog';
import {
  alertThreshold, checkStaleCriticalTasks, drainInFlight, LEASE_MS, maxParallel, registerTasks, releaseActiveLeases,
  runTaskNow, shortErrorMessage, shouldAlertOnFailures, tick, toView, type RunnerDeps, type TaskAlerts,
} from '../scheduled-task-runner';
import {
  innerLockTtlMs, T3_LEGACY_TRANSFER_TIMEOUT_MS, TO_PROCESS_SCAN_TIMEOUT_MS, WITHDRAWAL_SWEEP_TIMEOUT_MS,
} from '../task-timeouts';
import { acquireJobLock, acquireJobLockOrThrow, withJobLockOrSkip } from '@/lib/job-lock';
import type { FinishRecord, TaskRegistration, TaskStateRow, TaskStateStore, TaskTrigger } from '../scheduled-task-state';

const Z = (s: string) => new Date(s);
const MIN = 60_000;

// ─── Calendrier ─────────────────────────────────────────────────────────────

describe('calendrier — heures de Paris, changements d’heure', () => {
  it('8 h 30 à Paris = 06:30 UTC l’été, 07:30 UTC l’hiver', () => {
    expect(parisWallTimeToDate('2026-07-01', [8, 30]).toISOString()).toBe('2026-07-01T06:30:00.000Z');
    expect(parisWallTimeToDate('2026-12-01', [8, 30]).toISOString()).toBe('2026-12-01T07:30:00.000Z');
  });

  it('passage à l’heure d’été (29/03/2026) : le créneau du jour même reste à 8 h 30 locale', () => {
    // Veille au soir, 23 h à Paris (heure d'hiver).
    expect(nextDailyAt(Z('2026-03-28T22:00:00Z'), [8, 30]).toISOString()).toBe('2026-03-29T06:30:00.000Z');
    // Le lendemain du changement.
    expect(nextDailyAt(Z('2026-03-29T07:00:00Z'), [8, 30]).toISOString()).toBe('2026-03-30T06:30:00.000Z');
  });

  it('passage à l’heure d’hiver (25/10/2026) : 8 h 30 locale = 07:30 UTC', () => {
    expect(nextDailyAt(Z('2026-10-24T22:00:00Z'), [8, 30]).toISOString()).toBe('2026-10-25T07:30:00.000Z');
    expect(nextDailyAt(Z('2026-10-24T05:00:00Z'), [8, 30]).toISOString()).toBe('2026-10-24T06:30:00.000Z');
  });

  it('heure inexistante (2 h 30 le 29/03) : décalée après le saut, jamais perdue', () => {
    expect(parisWallTimeToDate('2026-03-29', [2, 30]).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('hebdomadaire : lundi 6 h 40 (Paris)', () => {
    // Lundi 5 octobre 2026, 7 h à Paris : passé → lundi suivant.
    expect(nextWeeklyAt(Z('2026-10-05T05:00:00Z'), 1, [6, 40]).toISOString()).toBe('2026-10-12T04:40:00.000Z');
    // Dimanche 25 octobre (changement d'heure) → lundi 26, heure d'hiver.
    expect(nextWeeklyAt(Z('2026-10-25T12:00:00Z'), 1, [6, 40]).toISOString()).toBe('2026-10-26T05:40:00.000Z');
  });

  const matin: TaskSchedule = { kind: 'interval', everyMs: 15 * MIN, window: { from: [8, 30], to: [11, 0] } };

  it('fenêtre du matin : /15 min de 8 h 30 à 11 h, puis lendemain 8 h 30', () => {
    // 8 h 31 Paris (été) → 8 h 46.
    expect(computeNextRun(matin, Z('2026-07-01T06:31:00Z'))!.toISOString()).toBe('2026-07-01T06:46:00.000Z');
    // 10 h 50 Paris → 11 h 05 hors fenêtre → lendemain 8 h 30.
    expect(computeNextRun(matin, Z('2026-07-01T08:50:00Z'))!.toISOString()).toBe('2026-07-02T06:30:00.000Z');
    // 6 h Paris : première échéance = 8 h 30 du jour.
    expect(computeFirstRun(matin, Z('2026-07-01T04:00:00Z'), MIN).toISOString()).toBe('2026-07-01T06:30:00.000Z');
    // Fenêtre à cheval sur le changement d'heure d'hiver.
    expect(computeNextRun(matin, Z('2026-10-24T09:00:00Z'))!.toISOString()).toBe('2026-10-25T07:30:00.000Z');
  });

  it('créneau périmé : pas d’envoi matinal à 23 h, pas de rafale', () => {
    expect(isSlotStillValid(matin, Z('2026-07-01T06:30:00Z'), Z('2026-07-01T21:00:00Z'))).toBe(false);
    expect(isSlotStillValid(matin, Z('2026-07-01T06:30:00Z'), Z('2026-07-01T06:45:00Z'))).toBe(true);
    const daily: TaskSchedule = { kind: 'daily', at: [5, 20], graceMs: 6 * 3600_000 };
    expect(isSlotStillValid(daily, Z('2026-07-01T03:20:00Z'), Z('2026-07-01T08:00:00Z'))).toBe(true);
    expect(isSlotStillValid(daily, Z('2026-07-01T03:20:00Z'), Z('2026-07-01T10:00:00Z'))).toBe(false);
    // Tâche horaire en retard de 3 h : exécutée UNE fois, la suivante 1 h après.
    const hourly: TaskSchedule = { kind: 'interval', everyMs: 60 * MIN };
    expect(isSlotStillValid(hourly, Z('2026-07-01T03:00:00Z'), Z('2026-07-01T06:00:00Z'))).toBe(true);
    expect(computeNextRun(hourly, Z('2026-07-01T06:00:10Z'))!.toISOString()).toBe('2026-07-01T07:00:10.000Z');
  });

  it('tâche de démarrage : suite seulement si demandée', () => {
    const s: TaskSchedule = { kind: 'startup', delayMs: 90_000, retryMs: 3600_000 };
    expect(computeNextRun(s, Z('2026-07-01T00:00:00Z'))).toBeNull();
    expect(computeNextRun(s, Z('2026-07-01T00:00:00Z'), { again: true })!.toISOString()).toBe('2026-07-01T01:00:00.000Z');
  });

  it('fréquences lisibles', () => {
    expect(describeSchedule({ kind: 'interval', everyMs: MIN })).toBe('toutes les minutes');
    expect(describeSchedule({ kind: 'interval', everyMs: 60 * MIN })).toBe('toutes les heures');
    expect(describeSchedule(matin)).toBe('toutes les 15 min, de 8 h 30 à 11 h (Paris)');
    expect(describeSchedule({ kind: 'weekly', isoDay: 1, at: [6, 40], graceMs: 0 })).toBe('chaque lundi à 6 h 40 (Paris)');
    expect(inParisWindow(Z('2026-12-01T07:30:00Z'), matin.window!)).toBe(true);
  });
});

// ─── Catalogue ──────────────────────────────────────────────────────────────

describe('catalogue', () => {
  it('reprend toutes les routes du planificateur externe, codes uniques', () => {
    const codes = SCHEDULED_TASKS.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(expect.arrayContaining([
      'notifications-dispatch', 'notifications-to-process-scan', 'notifications-scheduled-events',
      'notifications-purge', 'expire-trials', 'to-process-scan', 'duo-dunning', 'withdrawal-process',
      'referral-rewards', 'legal-verify-integrity', 't3-legacy-transfer',
    ]));
  });

  it('tâches critiques : envoi, rétractations, fin d’essai, balayage « À traiter » (lot 28)', () => {
    expect(SCHEDULED_TASKS.filter((t) => t.critical).map((t) => t.code).sort())
      .toEqual(['expire-trials', 'notifications-dispatch', 'to-process-scan', 'withdrawal-process']);
  });

  it('aucun créneau fixe dans la nuit de sauvegarde ni dans la plage 2 h – 3 h', () => {
    for (const t of SCHEDULED_TASKS) {
      if (t.schedule.kind === 'daily' || t.schedule.kind === 'weekly') {
        expect(t.schedule.at[0] >= 5, t.code).toBe(true);
      }
      expect(t.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('arrêt d’urgence : global et par tâche, aucune variable obligatoire', () => {
    expect(taskEnvVar('notifications-dispatch')).toBe('SCHEDULED_TASK_NOTIFICATIONS_DISPATCH');
    expect(isTaskEnabled('duo-dunning', {})).toBe(true);
    expect(isTaskEnabled('duo-dunning', { SCHEDULED_TASK_DUO_DUNNING: 'off' })).toBe(false);
    expect(isTaskEnabled('duo-dunning', { SCHEDULED_TASK_DUO_DUNNING: 'false' })).toBe(false);
    expect(isTaskEnabled('duo-dunning', { SCHEDULED_TASK_EXPIRE_TRIALS: 'off' })).toBe(true);
    expect(isTaskEnabled('duo-dunning', { SCHEDULED_TASKS_DISABLED: 'true' })).toBe(false);
    expect(schedulerDisabled({ SCHEDULED_TASKS_DISABLED: 'false' })).toBe(false);
    // DAILY_JOBS_DISABLED garde son périmètre (tâches quotidiennes).
    expect(isTaskEnabled('duo-dunning', { DAILY_JOBS_DISABLED: 'true' })).toBe(true);
  });

  it('démarré par l’amorçage Node, sans appel HTTP vers soi-même', () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
    expect(read('src/instrumentation-node.ts')).toMatch(/startScheduledTasks\(\)/);
    const catalog = read('src/services/scheduling/scheduled-tasks.catalog.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(catalog).not.toMatch(/fetch\(|['"`]\/api\/cron/);
  });
});

// ─── Messages, alertes ──────────────────────────────────────────────────────

describe('message court sans donnée sensible', () => {
  it('masque e-mails, identifiants, clés et jetons ; borne la longueur', () => {
    const m = shortErrorMessage(new Error(
      'échec pour jean.dupont@example.com via postgres://user:secret@db:5432/x clé sk_live_abcdefghijkl Bearer abc.def\nstack…',
    ));
    expect(m).not.toMatch(/jean\.dupont|secret|sk_live|abc\.def|stack/);
    expect(m).toMatch(/\[e-mail\]/);
    expect(shortErrorMessage(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(300);
    expect(shortErrorMessage(null)).toBe('erreur inconnue');
  });

  it('alerte au seuil puis tous les N échecs', () => {
    expect(alertThreshold({})).toBe(3);
    expect(alertThreshold({ SCHEDULED_TASK_ALERT_AFTER_FAILURES: '5' })).toBe(5);
    expect(alertThreshold({ SCHEDULED_TASK_ALERT_AFTER_FAILURES: 'abc' })).toBe(3);
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => shouldAlertOnFailures(n, 3))).toEqual([false, false, true, false, false, true, true]);
  });
});

// ─── Moteur ─────────────────────────────────────────────────────────────────

/** État en mémoire : mêmes règles que `pgTaskStateStore` (prise atomique). */
function memoryStore(clock: () => number) {
  const rows = new Map<string, TaskStateRow & { createdAt: Date }>();
  const blank = (code: string): TaskStateRow & { createdAt: Date } => ({
    code, scheduleSignature: null, nextRunAt: null, runningRunId: null, runningBy: null, runningUntil: null,
    lastTrigger: null, lastStartedAt: null, lastFinishedAt: null, lastDurationMs: null, lastStatus: null,
    lastError: null, lastInstance: null, lastSuccessAt: null, consecutiveFailures: 0, createdAt: new Date(clock()), running: false,
  });
  const free = (r: TaskStateRow) => !r.runningUntil || r.runningUntil.getTime() < clock();
  const store: TaskStateStore & { rows: typeof rows } = {
    rows,
    async ensure(regs: TaskRegistration[]) {
      for (const g of regs) {
        const r = rows.get(g.code) ?? blank(g.code);
        if (r.scheduleSignature !== g.signature) { r.scheduleSignature = g.signature; r.nextRunAt = g.firstRunAt; }
        if (g.bootRunAt) r.nextRunAt = new Date(Math.min(r.nextRunAt?.getTime() ?? Infinity, g.bootRunAt.getTime()));
        rows.set(g.code, r);
      }
    },
    async due() {
      return [...rows.values()].filter((r) => r.nextRunAt && r.nextRunAt.getTime() <= clock() && free(r))
        .map((r) => ({ code: r.code, nextRunAt: r.nextRunAt! }));
    },
    async claim(code: string, runId: string, owner: string, leaseMs: number, trigger: TaskTrigger, requireDue: boolean) {
      const r = rows.get(code);
      if (!r || !free(r)) return false;
      if (requireDue && !(r.nextRunAt && r.nextRunAt.getTime() <= clock())) return false;
      Object.assign(r, { runningRunId: runId, runningBy: owner, runningUntil: new Date(clock() + leaseMs),
        lastTrigger: trigger, lastStartedAt: new Date(clock()), lastInstance: owner });
      return true;
    },
    async reschedule(code: string, expected: Date, next: Date | null) {
      const r = rows.get(code);
      if (!r || r.nextRunAt?.getTime() !== expected.getTime() || !free(r)) return false;
      r.nextRunAt = next;
      return true;
    },
    async finish(code: string, runId: string, rec: FinishRecord) {
      const r = rows.get(code);
      if (!r || r.runningRunId !== runId) return null;
      Object.assign(r, {
        lastFinishedAt: new Date(clock()), lastDurationMs: rec.durationMs, lastStatus: rec.status, lastError: rec.error,
        lastSuccessAt: rec.skipped ? r.lastSuccessAt : rec.status === 'ok' ? new Date(clock()) : r.lastSuccessAt,
        consecutiveFailures: rec.skipped ? r.consecutiveFailures : rec.status === 'ok' ? 0 : r.consecutiveFailures + 1,
      });
      if (rec.nextRunAt !== 'keep') r.nextRunAt = rec.nextRunAt;
      if (rec.release) Object.assign(r, { runningRunId: null, runningBy: null, runningUntil: null });
      return { consecutiveFailures: r.consecutiveFailures };
    },
    async release(code: string, runId: string) {
      const r = rows.get(code);
      if (r && r.runningRunId === runId) Object.assign(r, { runningRunId: null, runningBy: null, runningUntil: null });
    },
    async renew(code: string, runId: string, leaseMs: number) {
      const r = rows.get(code);
      if (!r || r.runningRunId !== runId) return false;
      r.runningUntil = new Date(clock() + leaseMs);
      return true;
    },
    async list() {
      return [...rows.values()].map((r) => ({ ...r, running: Boolean(r.runningRunId && !free(r)) }));
    },
  };
  return store;
}

function harness(tasks: ScheduledTaskDef[], env: TaskEnv = {}) {
  let t = Date.parse('2026-07-01T10:00:00Z');
  const clock = () => t;
  const store = memoryStore(clock);
  const alerts = {
    report: vi.fn(async (_def: ScheduledTaskDef, _title: string, _detail: Record<string, unknown>) => undefined), resolve: vi.fn(async () => undefined), isOpen: vi.fn(async () => false) } satisfies TaskAlerts;
  const deps = (owner: string): RunnerDeps => ({
    store, tasks, env, alerts, owner, now: () => new Date(clock()), watchdogLock: async () => ({ release: async () => undefined }),
  });
  return { store, alerts, deps, advance: (ms: number) => { t += ms; }, clock };
}

const task = (code: string, run: ScheduledTaskDef['run'], extra: Partial<ScheduledTaskDef> = {}): ScheduledTaskDef => ({
  code, label: code, schedule: { kind: 'interval', everyMs: MIN }, timeoutMs: 1_000, startupDelayMs: 0, run, ...extra,
});

afterEach(async () => { await drainInFlight(); vi.useRealTimers(); });

describe('moteur — exclusivité entre instances', () => {
  it('deux instances au même tour : une seule exécution', async () => {
    const run = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const h = harness([task('a', run)]);
    await registerTasks(h.deps('web-1'));
    const [l1, l2] = await Promise.all([tick(h.deps('web-1')), tick(h.deps('web-2'))]);
    await drainInFlight();
    expect([...l1, ...l2]).toEqual(['a']);
    expect(run).toHaveBeenCalledTimes(1);
    const row = h.store.rows.get('a')!;
    expect(row.lastStatus).toBe('ok');
    expect(row.runningRunId).toBeNull();
    // Échéance suivante calculée après l'exécution : pas due tout de suite.
    expect(await tick(h.deps('web-2'))).toEqual([]);
    h.advance(MIN + 1);
    expect(await tick(h.deps('web-2'))).toEqual(['a']);
  });

  it('exécution manuelle refusée pendant une exécution planifiée (et inversement)', async () => {
    let finir!: () => void;
    let appels = 0;
    const run = vi.fn(() => (appels++ === 0 ? new Promise<void>((r) => { finir = r; }) : Promise.resolve()));
    const h = harness([task('a', run, { timeoutMs: 60_000 })]);
    await registerTasks(h.deps('web-1'));
    await tick(h.deps('web-1'));
    expect(await runTaskNow('a', { waitMs: 10 }, h.deps('web-2'))).toEqual({ status: 'busy' });
    finir();
    await drainInFlight();
    const manual = await runTaskNow('a', { waitMs: 1_000 }, h.deps('web-2'));
    expect(manual.status).toBe('finished');
    expect(run).toHaveBeenCalledTimes(2);
    expect(h.store.rows.get('a')!.lastTrigger).toBe('manual');
  });

  it('exécution manuelle : inconnue, arrêtée, échéance planifiée conservée', async () => {
    const h = harness([task('a', async () => undefined)], { SCHEDULED_TASK_A: 'off' });
    expect(await runTaskNow('zzz', {}, h.deps('w'))).toEqual({ status: 'not_found' });
    expect(await runTaskNow('a', {}, h.deps('w'))).toEqual({ status: 'disabled' });
    const h2 = harness([task('a', async () => undefined, { schedule: { kind: 'daily', at: [5, 20], graceMs: 0 } })]);
    await registerTasks(h2.deps('w'));
    const before = h2.store.rows.get('a')!.nextRunAt!.getTime();
    expect((await runTaskNow('a', {}, h2.deps('w'))).status).toBe('finished');
    expect(h2.store.rows.get('a')!.nextRunAt!.getTime()).toBe(before);
  });
});

describe('moteur — robustesse', () => {
  it('une tâche en erreur ne bloque pas les autres ; message court consigné', async () => {
    const ok = vi.fn(async () => ({ note: 'fait' }));
    const h = harness([
      task('casse', async () => { throw new Error('boum pour a@b.fr'); }),
      task('saine', ok),
    ], { SCHEDULED_TASKS_MAX_PARALLEL: '2' });
    await registerTasks(h.deps('w'));
    await tick(h.deps('w'));
    await drainInFlight();
    expect(ok).toHaveBeenCalledTimes(1);
    const casse = h.store.rows.get('casse')!;
    expect(casse.lastStatus).toBe('error');
    expect(casse.lastError).toBe('boum pour [e-mail]');
    expect(casse.consecutiveFailures).toBe(1);
    expect(h.store.rows.get('saine')!.lastStatus).toBe('ok');
  });

  it('délai dépassé : échec consigné, bail conservé tant que le travail continue', async () => {
    let finir!: () => void;
    const h = harness([task('lente', () => new Promise<void>((r) => { finir = r; }), {
      timeoutMs: 30, schedule: { kind: 'interval', everyMs: 10 },
    })]);
    await registerTasks(h.deps('w'));
    await tick(h.deps('w'));
    await drainInFlight();
    const row = h.store.rows.get('lente')!;
    expect(row.lastStatus).toBe('error');
    expect(row.lastError).toMatch(/délai dépassé/);
    expect(row.runningRunId).not.toBeNull();
    // Échéance atteinte, mais bail (2 × délai) encore posé : personne ne double.
    h.advance(20);
    expect(await tick(h.deps('autre'))).toEqual([]);
    finir();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.store.rows.get('lente')!.runningRunId).toBeNull();
    expect(await tick(h.deps('autre'))).toEqual(['lente']);
  });

  it('bail expiré (instance tuée) : la tâche est reprise, l’ancienne exécution ne peut plus écrire', async () => {
    const h = harness([task('a', async () => undefined, { timeoutMs: 1_000 })]);
    await registerTasks(h.deps('w'));
    // Prise par une instance qui meurt aussitôt.
    expect(await h.store.claim('a', 'mort', 'web-1', 2_000, 'schedule', true)).toBe(true);
    expect(await tick(h.deps('web-2'))).toEqual([]);
    h.advance(3_000);
    expect(await tick(h.deps('web-2'))).toEqual(['a']);
    await drainInFlight();
    expect(await h.store.finish('a', 'mort', { status: 'ok', error: null, durationMs: 1, nextRunAt: null, release: true })).toBeNull();
  });

  it('créneau périmé au redémarrage : sauté sans exécution', async () => {
    const run = vi.fn(async () => undefined);
    const h = harness([task('matin', run, { schedule: { kind: 'daily', at: [8, 30], graceMs: 3600_000 } })]);
    await registerTasks(h.deps('w'));
    // Échéance : 8 h 30 Paris le lendemain (06:30Z) ; on arrive à 23 h.
    h.advance(Date.parse('2026-07-02T21:00:00Z') - h.clock());
    expect(await tick(h.deps('w'))).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(h.store.rows.get('matin')!.nextRunAt!.toISOString()).toBe('2026-07-03T06:30:00.000Z');
  });

  it('tâche arrêtée : jamais prise ; arrêt global : aucun tour', async () => {
    const run = vi.fn(async () => undefined);
    const h = harness([task('a', run)], { SCHEDULED_TASK_A: 'off' });
    await registerTasks(h.deps('w'));
    expect(await tick(h.deps('w'))).toEqual([]);
    const g = harness([task('a', run)], { SCHEDULED_TASKS_DISABLED: 'true' });
    await registerTasks(g.deps('w'));
    expect(await tick(g.deps('w'))).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(toView(task('a', run), g.store.rows.get('a'), { SCHEDULED_TASKS_DISABLED: 'true' }).enabled).toBe(false);
  });
});

describe('moteur — tâche de démarrage (transfert T3)', () => {
  it('au démarrage, puis seulement tant qu’il reste du travail', async () => {
    let restant = 2;
    const run = vi.fn(async () => { restant -= 1; return restant > 0 ? { again: true } : { note: 'fini' }; });
    const h = harness([task('t3', run, { schedule: { kind: 'startup', delayMs: 1_000, retryMs: 10 * MIN } })]);
    await registerTasks(h.deps('w'));
    h.advance(1_001);
    expect(await tick(h.deps('w'))).toEqual(['t3']);
    await drainInFlight();
    expect(h.store.rows.get('t3')!.nextRunAt).not.toBeNull();
    h.advance(10 * MIN + 1);
    expect(await tick(h.deps('w'))).toEqual(['t3']);
    await drainInFlight();
    expect(h.store.rows.get('t3')!.nextRunAt).toBeNull();
    h.advance(24 * 3600_000);
    expect(await tick(h.deps('w'))).toEqual([]);
    // Nouveau démarrage : repassage (idempotent, sans travail).
    await registerTasks(h.deps('w2'));
    h.advance(1_001);
    expect(await tick(h.deps('w2'))).toEqual(['t3']);
    await drainInFlight();
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('moteur — alertes de Supervision', () => {
  it('tâche critique : alerte au 3e échec consécutif, résolue au succès', async () => {
    let echoue = true;
    const h = harness([task('dispatch', async () => { if (echoue) throw new Error('smtp'); }, { critical: { staleAfterMs: 15 * MIN } })]);
    await registerTasks(h.deps('w'));
    for (let i = 0; i < 3; i++) {
      expect(await tick(h.deps('w'))).toEqual(['dispatch']);
      await drainInFlight();
      h.advance(MIN + 1);
    }
    expect(h.alerts.report).toHaveBeenCalledTimes(1);
    expect(h.alerts.report.mock.calls[0][1]).toMatch(/3 échecs consécutifs/);
    echoue = false;
    await tick(h.deps('w'));
    await drainInFlight();
    expect(h.alerts.resolve).toHaveBeenCalled();
    expect(h.store.rows.get('dispatch')!.consecutiveFailures).toBe(0);
  });

  it('tâche non critique : aucune alerte', async () => {
    const h = harness([task('x', async () => { throw new Error('non'); })]);
    await registerTasks(h.deps('w'));
    for (let i = 0; i < 4; i++) { await tick(h.deps('w')); await drainInFlight(); h.advance(MIN + 1); }
    expect(h.alerts.report).not.toHaveBeenCalled();
  });

  it('chien de garde : tâche critique qui ne tourne plus → une alerte', async () => {
    const h = harness([task('dispatch', async () => undefined, { critical: { staleAfterMs: 15 * MIN } })]);
    const deps = { ...h.deps('w'), startedAt: new Date(0) };
    await registerTasks(deps);
    expect(await checkStaleCriticalTasks(deps)).toEqual([]);
    h.advance(16 * MIN);
    expect(await checkStaleCriticalTasks(deps)).toEqual(['dispatch']);
    expect(h.alerts.report).toHaveBeenCalledTimes(1);
    h.alerts.isOpen.mockResolvedValue(true);
    await checkStaleCriticalTasks(deps);
    expect(h.alerts.report).toHaveBeenCalledTimes(1);
    // Arrêt volontaire : pas d'alerte.
    expect(await checkStaleCriticalTasks({ ...deps, env: { SCHEDULED_TASK_DISPATCH: 'off' } })).toEqual([]);
  });
});

// ─── Revue indépendante du lot 25 ───────────────────────────────────────────

describe('revue I1 — bail court, renouvelé, rendu à l’arrêt', () => {
  it('bail de 90 s renouvelé pendant l’exécution ; ramené à 10 s à l’arrêt du processus', async () => {
    let finir!: () => void;
    const h = harness([task('longue', () => new Promise<void>((r) => { finir = r; }), { timeoutMs: 60 * MIN })]);
    const deps = { ...h.deps('web-1'), renewEveryMs: 5 };
    const renew = vi.spyOn(h.store, 'renew');
    await registerTasks(deps);
    await tick(deps);
    const row = h.store.rows.get('longue')!;
    expect(row.runningUntil!.getTime() - h.clock()).toBe(LEASE_MS);
    await new Promise((r) => setTimeout(r, 30));
    expect(renew).toHaveBeenCalled();
    // SIGTERM : le bail ne bloque plus la tâche que 10 s.
    expect(await releaseActiveLeases()).toBeGreaterThanOrEqual(1);
    expect(row.runningUntil!.getTime() - h.clock()).toBe(10_000);
    h.advance(MIN + 11_000);
    expect(await h.store.claim('longue', 'reprise', 'web-2', LEASE_MS, 'schedule', true)).toBe(true);
    finir();
    await drainInFlight();
    // L'ancienne exécution ne peut plus écrire l'état de la reprise.
    expect(h.store.rows.get('longue')!.runningRunId).toBe('reprise');
  });

  it('instance tuée sans arrêt propre : tâche reprise après 90 s, pas 2 × délai', async () => {
    const h = harness([task('dispatch', async () => undefined, { timeoutMs: 4 * MIN })]);
    await registerTasks(h.deps('w'));
    expect(await h.store.claim('dispatch', 'mort', 'web-1', LEASE_MS, 'schedule', true)).toBe(true);
    h.advance(LEASE_MS - 1);
    expect(await tick(h.deps('web-2'))).toEqual([]);
    h.advance(2);
    expect(await tick(h.deps('web-2'))).toEqual(['dispatch']);
  });
});

describe('revue I2 — verrous internes ≥ durée de vie d’une exécution', () => {
  it('to-process-scan, withdrawal, transfert T3 : verrou ≥ 2 × délai du catalogue', () => {
    const t = (code: string) => SCHEDULED_TASKS.find((x) => x.code === code)!.timeoutMs;
    expect(t('to-process-scan')).toBe(TO_PROCESS_SCAN_TIMEOUT_MS);
    expect(t('withdrawal-process')).toBe(WITHDRAWAL_SWEEP_TIMEOUT_MS);
    expect(t('t3-legacy-transfer')).toBe(T3_LEGACY_TRANSFER_TIMEOUT_MS);
    for (const ms of [TO_PROCESS_SCAN_TIMEOUT_MS, WITHDRAWAL_SWEEP_TIMEOUT_MS, T3_LEGACY_TRANSFER_TIMEOUT_MS]) {
      expect(innerLockTtlMs(ms)).toBeGreaterThan(2 * ms);
    }
  });

  it('les traitements utilisent ce TTL (même source de vérité)', () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
    expect(read('src/services/to-process/to-process-scan.job.ts')).toMatch(/innerLockTtlMs\(TO_PROCESS_SCAN_TIMEOUT_MS\)/);
    expect(read('src/services/withdrawal/withdrawal-sweep.job.ts')).toMatch(/innerLockTtlMs\(WITHDRAWAL_SWEEP_TIMEOUT_MS\)/);
    expect(read('src/services/ai/reconciliation/legacy-queue-transfer.ts')).toMatch(/innerLockTtlMs\(T3_LEGACY_TRANSFER_TIMEOUT_MS\)/);
  });
});

describe('revue I3 — verrou détenu ≠ erreur de base', () => {
  it('erreur d’acquisition : levée (variante stricte), null seulement si détenu', async () => {
    dbExecute.mockRejectedValue(new Error('connexion refusée'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await acquireJobLock('x', 1_000)).toBeNull();
    await expect(acquireJobLockOrThrow('x', 1_000)).rejects.toThrow('connexion refusée');
    const travail = vi.fn(async () => 1);
    await expect(withJobLockOrSkip('x', 1_000, travail)).rejects.toThrow('connexion refusée');
    dbExecute.mockResolvedValue([]);
    expect(await withJobLockOrSkip('x', 1_000, travail)).toBeNull();
    expect(travail).not.toHaveBeenCalled();
    dbExecute.mockResolvedValue([{ name: 'x' }]);
    expect(await withJobLockOrSkip('x', 1_000, travail)).toBe(1);
  });

  it('passage ignoré : consigné ok sans avancer le dernier succès ni résoudre l’alerte', async () => {
    let ignorer = false;
    const h = harness([task('withdrawal', async () => (ignorer ? { skipped: true, note: 'ignoré' } : { note: 'ok' }),
      { critical: { staleAfterMs: 3 * 3600_000 } })]);
    await registerTasks(h.deps('w'));
    await tick(h.deps('w')); await drainInFlight();
    const succes = h.store.rows.get('withdrawal')!.lastSuccessAt!.getTime();
    h.alerts.resolve.mockClear();
    ignorer = true;
    h.advance(MIN + 1);
    await tick(h.deps('w')); await drainInFlight();
    const row = h.store.rows.get('withdrawal')!;
    expect(row.lastStatus).toBe('ok');
    expect(row.lastSuccessAt!.getTime()).toBe(succes);
    expect(h.alerts.resolve).not.toHaveBeenCalled();
    // Ignoré trop longtemps : le chien de garde le voit.
    h.advance(4 * 3600_000);
    expect(await checkStaleCriticalTasks({ ...h.deps('w'), startedAt: new Date(0) })).toEqual(['withdrawal']);
  });
});

describe('revue I4 — charge bornée par instance', () => {
  it('une tâche à la fois hors envoi des notifications ; pool saturé : rien', async () => {
    const lente = () => new Promise<void>((r) => setTimeout(r, 20));
    const h = harness([
      task('a', lente), task('b', lente), task('dispatch', lente, { ownSlot: true }),
    ]);
    await registerTasks(h.deps('w'));
    const lances = await tick(h.deps('w'));
    expect(lances).toHaveLength(2);
    expect(lances).toContain('dispatch');
    await drainInFlight();
    expect(maxParallel({})).toBe(1);
    expect(maxParallel({ SCHEDULED_TASKS_MAX_PARALLEL: '2' })).toBe(2);
    expect(maxParallel({ SCHEDULED_TASKS_MAX_PARALLEL: '50' })).toBe(1);

    const g = harness([task('a', lente)]);
    await registerTasks(g.deps('w'));
    expect(await tick({ ...g.deps('w'), poolBusy: async () => true })).toEqual([]);
    expect(await tick({ ...g.deps('w'), poolBusy: async () => false })).toEqual(['a']);
  });
});

describe('revue M2 — tâche réactivée', () => {
  it('pas d’alerte « aucune exécution réussie » avant sa première échéance', async () => {
    const h = harness([task('dispatch', async () => undefined, { critical: { staleAfterMs: 15 * MIN } })]);
    await registerTasks(h.deps('w'));
    // Dernier succès il y a des jours (tâche arrêtée), moteur redémarré à l'instant.
    h.store.rows.get('dispatch')!.lastSuccessAt = new Date(h.clock() - 5 * 24 * 3600_000);
    const deps = { ...h.deps('w'), startedAt: new Date(h.clock()) };
    expect(await checkStaleCriticalTasks(deps)).toEqual([]);
    h.advance(16 * MIN);
    expect(await checkStaleCriticalTasks(deps)).toEqual(['dispatch']);
  });
});
