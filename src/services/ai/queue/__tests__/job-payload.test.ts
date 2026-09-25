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
    expect(ins.sql).toMatch(/trigger_code, payload\)/);
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
