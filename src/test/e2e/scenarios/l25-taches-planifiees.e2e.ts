/**
 * Lot 25, chantier A — tâches planifiées internes sur PostgreSQL réel.
 *
 *   1. deux « instances » (deux identités, même base) au même tour : une
 *      seule exécution ; prise atomique sous concurrence ;
 *   2. état persistant (début, fin, durée, résultat, message court,
 *      prochaine échéance, échecs consécutifs, instance) ;
 *   3. exécution manuelle par la route BO : résultat, exclusivité (409),
 *      journal d'audit admin ; lecture de l'état par la route BO ;
 *   4. transfert de l'ancienne file T3 au démarrage : une seule fois même
 *      avec deux instances, idempotent au redémarrage.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { ScheduledTaskDef } from '@/services/scheduling/scheduled-tasks.catalog';
import type { RunnerDeps } from '@/services/scheduling/scheduled-task-runner';

const admin = { id: 0 };
vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => admin.id,
  getSession: async () => ({ userId: admin.id, email: 'admin-e2e@test.invalid' }),
  isSessionError: () => false,
  sessionErrorResponse: () => new Response(null, { status: 401 }),
}));

async function depsFor(owner: string, tasks: readonly ScheduledTaskDef[], decalageMs = 1_000): Promise<RunnerDeps> {
  const { pgTaskStateStore } = await import('@/services/scheduling/scheduled-task-state');
  return {
    store: pgTaskStateStore,
    tasks,
    env: { SCHEDULED_TASKS_MAX_PARALLEL: '2' },
    alerts: { report: async () => undefined, resolve: async () => undefined, isOpen: async () => false },
    owner,
    // Horloge applicative légèrement en retard sur le serveur : les premières
    // échéances calculées sont déjà atteintes pour PostgreSQL.
    now: () => new Date(Date.now() - decalageMs),
    watchdogLock: async () => null,
  };
}

scenario('L25-A', 'Tâches planifiées internes', ({ sql, make }) => {
  it('deux instances au même tour : une seule exécution, état persistant', async () => {
    const { registerTasks, tick, drainInFlight } = await import('@/services/scheduling/scheduled-task-runner');
    let executions = 0;
    const lente: ScheduledTaskDef = {
      code: 'e2e-exclusive', label: 'E2E', schedule: { kind: 'interval', everyMs: 3_600_000 }, timeoutMs: 30_000, startupDelayMs: 0,
      run: async () => { executions += 1; await new Promise((r) => setTimeout(r, 150)); return { note: 'ok' }; },
    };
    const casse: ScheduledTaskDef = {
      code: 'e2e-erreur', label: 'E2E erreur', schedule: { kind: 'interval', everyMs: 3_600_000 }, timeoutMs: 30_000, startupDelayMs: 0,
      run: async () => { throw new Error('refus de contact@example.com\ndétail interne'); },
    };
    const w1 = await depsFor('web-1:e2e', [lente, casse]);
    const w2 = await depsFor('web-2:e2e', [lente, casse]);
    await Promise.all([registerTasks(w1), registerTasks(w2)]);

    const [a, b] = await Promise.all([tick(w1), tick(w2)]);
    await drainInFlight();
    expect([...a, ...b].filter((c) => c === 'e2e-exclusive')).toHaveLength(1);
    expect(executions).toBe(1);

    const [row] = await sql`SELECT * FROM scheduled_task_state WHERE code = 'e2e-exclusive'`;
    expect(row.last_status).toBe('ok');
    expect(row.last_trigger).toBe('schedule');
    expect(['web-1:e2e', 'web-2:e2e']).toContain(row.last_instance);
    expect(Number(row.last_duration_ms)).toBeGreaterThanOrEqual(100);
    expect(row.running_run_id).toBeNull();
    expect(new Date(row.last_finished_at).getTime()).toBeGreaterThanOrEqual(new Date(row.last_started_at).getTime());
    // Échéance suivante : une heure après la fin, pas de nouvelle exécution.
    expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await tick(w1)).toEqual([]);

    const [err] = await sql`SELECT * FROM scheduled_task_state WHERE code = 'e2e-erreur'`;
    expect(err.last_status).toBe('error');
    expect(err.consecutive_failures).toBe(1);
    expect(err.last_error).toBe('refus de [e-mail]');
  });

  it('prise atomique : vingt prises simultanées, une seule réussit', async () => {
    const { pgTaskStateStore } = await import('@/services/scheduling/scheduled-task-state');
    await pgTaskStateStore.ensure([{ code: 'e2e-race', signature: 's', firstRunAt: new Date(Date.now() - 5_000) }]);
    const prises = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      pgTaskStateStore.claim('e2e-race', `run-${i}`, `web-${i}`, 60_000, 'schedule', true)));
    expect(prises.filter(Boolean)).toHaveLength(1);
    // Bail posé : même une exécution manuelle est refusée.
    expect(await pgTaskStateStore.claim('e2e-race', 'manuel', 'bo', 60_000, 'manual', false)).toBe(false);
    // Renouvellement clôturé par l'exécution ; fin anticipée (arrêt du processus).
    const gagnant = (await sql`SELECT running_run_id FROM scheduled_task_state WHERE code = 'e2e-race'`)[0].running_run_id as string;
    expect(await pgTaskStateStore.renew('e2e-race', 'intrus', 60_000)).toBe(false);
    expect(await pgTaskStateStore.renew('e2e-race', gagnant, 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await pgTaskStateStore.claim('e2e-race', 'reprise', 'web-x', 60_000, 'manual', false)).toBe(true);
  });

  it('passage ignoré (verrou interne détenu par la route) : ok, sans avancer le dernier succès', async () => {
    const { runTaskNow } = await import('@/services/scheduling/scheduled-task-runner');
    const { acquireJobLock, releaseJobLock } = await import('@/lib/job-lock');
    await sql`DELETE FROM scheduled_task_state WHERE code = 'withdrawal-process'`;
    const verrou = await acquireJobLock('withdrawal-sweep', 60_000);
    expect(verrou).not.toBeNull();
    try {
      const r = await runTaskNow('withdrawal-process', { waitMs: 10_000 });
      expect(r).toMatchObject({ status: 'finished', outcome: { status: 'ok', skipped: true } });
      const [st] = await sql`SELECT last_status, last_success_at, consecutive_failures FROM scheduled_task_state WHERE code = 'withdrawal-process'`;
      expect(st).toMatchObject({ last_status: 'ok', last_success_at: null, consecutive_failures: 0 });
    } finally {
      await releaseJobLock(verrou!);
    }
  });

  it('exécution manuelle par la route BO : fin d’essai, exclusivité, audit', async () => {
    const acc = await make.account();
    admin.id = acc.ownerUserId;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at)
              VALUES (${acc.id}, 'premium', 'trialing', now() - interval '1 hour')`;

    const { POST } = await import('@/app/api/admin/ops/scheduled-tasks/[code]/run/route');
    const { GET } = await import('@/app/api/admin/ops/scheduled-tasks/route');
    const post = (code: string, body?: unknown) => POST(
      new NextRequest(`http://localhost/api/admin/ops/scheduled-tasks/${code}/run`, {
        method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
      }),
      { params: Promise.resolve({ code }) },
    );

    expect((await post('expire-trials', { reason: 42 })).status).toBe(400);
    const res = await post('expire-trials', { reason: '  Rattrapage après incident  ' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ result: 'finished', status: 'ok' });
    expect(body.task).toMatchObject({ code: 'expire-trials', lastStatus: 'ok', enabled: true, consecutiveFailures: 0 });

    const [sub] = await sql`SELECT status FROM account_subscriptions WHERE account_id = ${acc.id}`;
    expect(sub.status).toBe('readonly');
    const [st] = await sql`SELECT last_trigger, last_status FROM scheduled_task_state WHERE code = 'expire-trials'`;
    expect(st).toMatchObject({ last_trigger: 'manual', last_status: 'ok' });

    // Exécution en cours sur une autre instance : refus, sans exécution.
    await sql`UPDATE scheduled_task_state SET running_run_id = 'ailleurs', running_by = 'web-9',
                running_until = now() + interval '5 minutes' WHERE code = 'expire-trials'`;
    const busy = await post('expire-trials');
    expect(busy.status).toBe(409);
    expect((await busy.json()).code).toBe('TASK_RUNNING');
    await sql`UPDATE scheduled_task_state SET running_run_id = NULL, running_by = NULL, running_until = NULL WHERE code = 'expire-trials'`;

    expect((await post('inconnue')).status).toBe(404);

    const audit = await sql`SELECT result, details, admin_email FROM admin_audit_log
                             WHERE action_type = 'SCHEDULED_TASK_RUN' AND admin_user_id = ${admin.id} ORDER BY id`;
    expect(audit.map((r) => r.result)).toEqual(['SUCCESS', 'DENIED']);
    expect(JSON.parse(audit[0].details as string)).toMatchObject({ code: 'expire-trials', outcome: 'ok', reason: 'Rattrapage après incident' });
    expect(audit[0].admin_email).toBe('admin-e2e@test.invalid');

    const list = await (await GET(new NextRequest('http://localhost/api/admin/ops/scheduled-tasks'))).json();
    expect(list.schedulerEnabled).toBe(true);
    const codes = list.tasks.map((t: { code: string }) => t.code);
    expect(codes).toContain('notifications-dispatch');
    const et = list.tasks.find((t: { code: string }) => t.code === 'expire-trials');
    expect(et).toMatchObject({ lastStatus: 'ok', frequency: 'toutes les heures', enabled: true });
    expect(Object.keys(et)).toEqual(expect.arrayContaining([
      'code', 'label', 'frequency', 'lastRunAt', 'lastStatus', 'lastDurationMs', 'lastError', 'nextRunAt', 'consecutiveFailures', 'enabled',
    ]));
  });

  it('transfert T3 au démarrage : une fois avec deux instances, idempotent au redémarrage', async () => {
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const { registerTasks, tick, drainInFlight } = await import('@/services/scheduling/scheduled-task-runner');
    const t3 = SCHEDULED_TASKS.filter((t) => t.code === 't3-legacy-transfer');

    const c1 = await make.account();
    const c2 = await make.account();
    for (const c of [c1, c2]) {
      await sql`INSERT INTO account_reconciliation_runs (account_id, trigger_type, trigger_event, correlation_id, status, not_before)
                VALUES (${c.id}, 'event', 'document_linked', ${`e2e-${c.id}`}, 'queued', now())`;
    }

    // Démarrage des deux instances : échéance de démarrage (90 s) déjà atteinte.
    const w1 = await depsFor('web-1:e2e', t3, 120_000);
    const w2 = await depsFor('web-2:e2e', t3, 120_000);
    await Promise.all([registerTasks(w1), registerTasks(w2)]);
    const [a, b] = await Promise.all([tick(w1), tick(w2)]);
    await drainInFlight();
    expect([...a, ...b]).toEqual(['t3-legacy-transfer']);

    const restant = await sql`SELECT count(*)::int AS n FROM account_reconciliation_runs
                               WHERE status = 'queued' AND account_id IN (${c1.id}, ${c2.id})`;
    expect(restant[0].n).toBe(0);
    const jobs = await sql`SELECT account_id, count(*)::int AS n FROM ai_job_queue
                            WHERE treatment = 'T3' AND account_id IN (${c1.id}, ${c2.id}) GROUP BY account_id`;
    expect(jobs.map((j) => j.n)).toEqual([1, 1]);

    const [st] = await sql`SELECT last_status, last_trigger, next_run_at FROM scheduled_task_state WHERE code = 't3-legacy-transfer'`;
    expect(st).toMatchObject({ last_status: 'ok', last_trigger: 'startup', next_run_at: null });
    // En sommeil : plus aucun passage tant qu'aucune instance ne redémarre.
    expect(await tick(w1)).toEqual([]);

    // Redémarrage : nouveau passage, sans rien transférer ni dupliquer.
    await registerTasks(w2);
    expect(await tick(w2)).toEqual(['t3-legacy-transfer']);
    await drainInFlight();
    const apres = await sql`SELECT count(*)::int AS n FROM ai_job_queue
                             WHERE treatment = 'T3' AND account_id IN (${c1.id}, ${c2.id})`;
    expect(apres[0].n).toBe(2);
  });
});
