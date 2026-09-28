/**
 * Contexte de reprise des jobs IA durables : le payload est persisté à
 * chaque insertion (création, passage consolidé), et la mise en file n'est
 * acquittée qu'après sa relecture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let respond: (sql: string, params: unknown[]) => unknown[] = () => [];

vi.mock('@/db', () => ({
  pgClient: { unsafe: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return respond(sql, params); } },
}));

const { enqueue, completeJob } = await import('../job-queue.repository');

/** Nombre de paramètres positionnels ($1…$n) d'une requête. */
const placeholders = (sql: string) => Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

beforeEach(() => { calls.length = 0; respond = () => []; });

describe('INSERT ai_job_queue', () => {
  it('déclare autant de paramètres qu’il en reçoit, payload compris', async () => {
    respond = (sql, params) => (sql.includes('INSERT') ? [{ id: 5, payload: JSON.parse(String(params[7])) }] : []);
    const r = await enqueue({ treatment: 'T1', scope: { accountId: 1, targetType: 'asset_file', targetId: 42 }, triggerCode: 'upload', payload: { fileId: 42, userId: 7, origin: 'upload' } });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO ai_job_queue'))!;
    expect(ins.sql).toMatch(/trigger_code, payload, available_at\)/);
    expect(placeholders(ins.sql)).toBe(ins.params.length);
    expect(JSON.parse(String(ins.params[7]))).toEqual({ fileId: 42, userId: 7, origin: 'upload' });
    expect(r).toEqual({ decision: 'create', jobId: 5 });
  });

  it('n’acquitte pas un job relu sans son contexte', async () => {
    respond = (sql) => (sql.includes('INSERT') ? [{ id: 6, payload: null }] : []);
    await expect(enqueue({ treatment: 'T1', scope: { accountId: 1 }, payload: { fileId: 1 } })).rejects.toThrow(/contexte de reprise/);
  });

  it('le passage consolidé (coalescence) ré-insère le payload d’origine', async () => {
    const payload = { fileId: 9, userId: 3, origin: 'reanalyse' };
    respond = (sql, params) => {
      if (sql.includes("SET status = 'DONE'")) {
        return [{ id: 1, treatment: 'T1', account_id: 1, target_type: 'asset_file', target_id: '9', status: 'DONE', origin: 'automatic', attempts: 1, available_at: new Date(), coalesce_requested: true, head_priority: false, created_at: new Date(), payload }];
      }
      if (sql.includes('INSERT')) return [{ id: 2, payload: JSON.parse(String(params[7])) }];
      return [];
    };
    expect(await completeJob(1)).toMatchObject({ requeued: true });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO ai_job_queue'))!;
    expect(JSON.parse(String(ins.params[7]))).toEqual(payload);
  });
});

describe('options de mise en file (lot IA 2 — T3/T4 durables)', () => {
  it('temporise le premier prélèvement (T3 événementiel)', async () => {
    respond = (sql, params) => (sql.includes('INSERT') ? [{ id: 7, payload: JSON.parse(String(params[7])) }] : []);
    await enqueue({ treatment: 'T3', scope: { accountId: 2 }, payload: { events: [] }, delaySeconds: 600 });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO ai_job_queue'))!;
    expect(ins.params[8]).toBe('600');
    expect(ins.sql).toMatch(/NOW\(\) \+ \(\$9 \|\| ' seconds'\)::interval/);
  });

  it('remplace le contexte d’un job en attente absorbant (T4 : candidats les plus récents)', async () => {
    respond = (sql) => (sql.startsWith('SELECT id, status') ? [{ id: 11, status: 'PENDING' }] : []);
    const r = await enqueue({ treatment: 'T4', scope: { accountId: 1, targetType: 'asset_file', targetId: 3 }, payload: { candidates: [1] }, payloadOnDedupe: 'replace' });
    expect(r).toEqual({ decision: 'skip', jobId: 11 });
    const upd = calls.find((c) => c.sql.includes('SET payload = $2::jsonb'))!;
    expect(upd.params).toEqual([11, JSON.stringify({ candidates: [1] })]);
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('accumule les événements fusionnés, bornés (T3)', async () => {
    respond = (sql) => (sql.startsWith('SELECT id, status') ? [{ id: 12, status: 'RUNNING' }] : []);
    const r = await enqueue({ treatment: 'T3', scope: { accountId: 1 }, payload: { events: [{ event: 'asset_updated' }] }, payloadOnDedupe: 'append_events' });
    expect(r.decision).toBe('coalesce');
    expect(calls.some((c) => c.sql.includes('coalesce_requested = TRUE'))).toBe(true);
    const upd = calls.find((c) => c.sql.includes("'{events}'"))!;
    expect(upd.params[0]).toBe(12);
    expect(upd.params[2]).toBe(50);
  });

  it('sans option, le job absorbant garde son contexte (T1)', async () => {
    respond = (sql) => (sql.startsWith('SELECT id, status') ? [{ id: 13, status: 'PENDING' }] : []);
    await enqueue({ treatment: 'T1', scope: { accountId: 1, targetType: 'asset_file', targetId: 4 }, payload: { fileId: 4 } });
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });
});

describe('prélèvement et relance', () => {
  it('fige la version de configuration au démarrage (VER-016)', async () => {
    const { claimNext } = await import('../job-queue.repository');
    respond = (sql) => (sql.includes('ai_emergency_stop') ? [{ active: false }] : []);
    await claimNext('T3', 'w1', 300, 42);
    const upd = calls.find((c) => c.sql.includes("SET status = 'RUNNING'"))!;
    expect(upd.sql).toMatch(/config_version_id = \$4/);
    expect(upd.params).toEqual(['T3', 'w1', '300', 42]);
  });

  it('relance un échec définitif depuis zéro, comme lancement manuel (MOD-006)', async () => {
    const { retryFailedJob } = await import('../job-queue.repository');
    respond = (sql) => (sql.includes("status = 'FAILED'") ? [{ id: 9 }] : []);
    expect(await retryFailedJob(9)).toBe(true);
    const upd = calls[calls.length - 1];
    expect(upd.sql).toMatch(/attempts = 0, origin = 'manual'/);
    expect(upd.sql).toMatch(/WHERE id = \$1 AND status = 'FAILED'/);
    respond = () => [];
    expect(await retryFailedJob(10)).toBe(false);
  });
});
